import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { authorizeClient, type McpClient, registerClient } from "../mcp/testing.ts";
import {
  createLiveTestServer,
  createTestServer,
  htmlFile,
  type LiveTestServer,
  type TestServer,
  VARDA_USER,
  WORKSPACE_USER,
} from "../testing.ts";
import { RETENTION_MS, WEBHOOK_MAX_BYTES } from "./routes.ts";

const SECRET = "w".repeat(40);

let server: TestServer;

const PULL_REQUEST = {
  action: "synchronize",
  number: 12,
  repository: { full_name: "acme/app" },
  pull_request: { number: 12, head: { sha: "a".repeat(40) } },
};

function deliver(
  payload: unknown,
  headers: { event?: string; delivery?: string; signature?: string | null } = {},
) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const signature =
    headers.signature === undefined
      ? `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`
      : headers.signature;
  return server.app.request("/api/integrations/varda/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-GitHub-Event": headers.event ?? "pull_request",
      "X-GitHub-Delivery": headers.delivery ?? crypto.randomUUID(),
      ...(signature === null ? {} : { "X-Hub-Signature-256": signature }),
    },
    body,
  });
}

const rows = () => server.vardaOutbox.backlog().map((row) => JSON.parse(row.data));

describe("the GitHub endpoint", () => {
  afterEach(() => {
    server.cleanup();
  });

  test("a signed pull_request event writes one row with repo, pr, head and action", async () => {
    server = await createTestServer({ varda: { webhookSecret: SECRET } });
    expect((await deliver(PULL_REQUEST)).status).toBe(204);
    expect(rows()).toEqual([
      {
        type: "github",
        event: "pull_request",
        action: "synchronize",
        repo: "acme/app",
        pr: 12,
        head: "a".repeat(40),
        at: expect.any(String),
      },
    ]);
  });

  test("a wrong signature and a missing one get 401 and write nothing", async () => {
    server = await createTestServer({ varda: { webhookSecret: SECRET } });
    const forged = `sha256=${createHmac("sha256", "x".repeat(40)).update(JSON.stringify(PULL_REQUEST)).digest("hex")}`;
    expect((await deliver(PULL_REQUEST, { signature: forged })).status).toBe(401);
    expect((await deliver(PULL_REQUEST, { signature: "sha256=00" })).status).toBe(401);
    expect((await deliver(PULL_REQUEST, { signature: null })).status).toBe(401);
    expect(rows()).toEqual([]);
  });

  test("the same delivery twice writes one row", async () => {
    server = await createTestServer({ varda: { webhookSecret: SECRET } });
    expect((await deliver(PULL_REQUEST, { delivery: "d-1" })).status).toBe(204);
    expect((await deliver(PULL_REQUEST, { delivery: "d-1" })).status).toBe(204);
    expect(rows()).toHaveLength(1);
  });

  test("ping and issues events get 204 and write nothing", async () => {
    server = await createTestServer({ varda: { webhookSecret: SECRET } });
    expect((await deliver({ zen: "Keep it simple." }, { event: "ping" })).status).toBe(204);
    expect((await deliver({ action: "opened", issue: {} }, { event: "issues" })).status).toBe(204);
    expect(rows()).toEqual([]);
  });

  test("a signed pull_request event without the expected fields writes nothing", async () => {
    server = await createTestServer({ varda: { webhookSecret: SECRET } });
    expect((await deliver({ action: "opened" })).status).toBe(204);
    expect((await deliver("not json")).status).toBe(204);
    expect(rows()).toEqual([]);
  });

  test("a body over 1 MiB gets 413", async () => {
    server = await createTestServer({ varda: { webhookSecret: SECRET } });
    const big = { ...PULL_REQUEST, padding: "x".repeat(WEBHOOK_MAX_BYTES) };
    expect((await deliver(big)).status).toBe(413);
    expect(rows()).toEqual([]);
  });

  test("without the webhook secret, or with the integration off, the path is 404", async () => {
    server = await createTestServer({ varda: {} });
    expect((await deliver(PULL_REQUEST)).status).toBe(404);
    server.cleanup();
    server = await createTestServer();
    expect((await deliver(PULL_REQUEST)).status).toBe(404);
    expect(rows()).toEqual([]);
  });
});

describe("the stream and acknowledgement", () => {
  let live: LiveTestServer;
  let varda: McpClient;
  let shift = 0;

  beforeEach(async () => {
    shift = 0;
    live = await createLiveTestServer({ varda: { now: () => Date.now() + shift } });
    const cookie = await live.signIn(VARDA_USER);
    varda = await authorizeClient(live, { cookie, clientId: await registerClient(live, cookie) });
  });
  afterEach(() => {
    live.stop();
  });

  const STREAM = "/api/integrations/varda/stream";
  const get = (headers: Record<string, string> = {}) =>
    fetch(`${live.origin}${STREAM}`, { headers });
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const ack = (token: string, body: unknown) =>
    fetch(`${live.origin}/api/integrations/varda/ack`, {
      method: "POST",
      headers: { ...bearer(token), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const insert = (data: object) => {
    const text = JSON.stringify(data);
    const id = live.vardaOutbox.insert(text);
    if (id === null) throw new Error("not inserted");
    live.vardaOutbox.announce({ id, data: text });
    return id;
  };

  /** Reads server-sent events from an open stream. */
  function reader(response: Response) {
    const stream = response.body?.getReader();
    if (!stream) throw new Error("no body");
    const decoder = new TextDecoder();
    let buffer = "";
    let ended = false;
    const blocks: string[] = [];
    const fill = async (until: () => boolean) => {
      const deadline = Date.now() + 3000;
      while (!until() && !ended) {
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`timed out with ${JSON.stringify(blocks)}`);
        const read = await Promise.race([stream.read(), Bun.sleep(left).then(() => null)]);
        if (read === null) continue;
        if (read.done) ended = true;
        else buffer += decoder.decode(read.value, { stream: true });
        for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
          blocks.push(buffer.slice(0, end));
          buffer = buffer.slice(end + 2);
        }
      }
    };
    const rows = () =>
      blocks
        .filter((block) => block.startsWith("id: "))
        .map((block) => {
          const [idLine = "", dataLine = ""] = block.split("\n");
          return { id: Number(idLine.slice(4)), data: JSON.parse(dataLine.slice(6)) };
        });
    return {
      blocks,
      rows,
      /** Waits until `count` rows have arrived. */
      until: (count: number) => fill(() => rows().length >= count),
      /** Waits until the server closes the stream. */
      end: async () => {
        await fill(() => false);
        return ended;
      },
      cancel: () => stream.cancel(),
    };
  }

  test("no token gets 401", async () => {
    expect((await get()).status).toBe(401);
  });

  test("a cookie without a token gets 401", async () => {
    const cookie = await live.signIn(VARDA_USER);
    expect((await get({ cookie })).status).toBe(401);
    expect((await ack("", { ids: [1] })).status).toBe(401);
  });

  test("another user's token gets 403", async () => {
    const cookie = await live.signIn(WORKSPACE_USER);
    const other = await authorizeClient(live, {
      cookie,
      clientId: await registerClient(live, cookie),
    });
    expect((await get(bearer(other.accessToken))).status).toBe(403);
    expect((await ack(other.accessToken, { ids: [1] })).status).toBe(403);
  });

  test("Varda's token gets the backlog in id order, then a row written after the connect", async () => {
    const first = insert({ type: "github", n: 1 });
    const second = insert({ type: "github", n: 2 });
    const response = await get(bearer(varda.accessToken));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const stream = reader(response);
    await stream.until(2);
    expect(stream.blocks[0]).toBe("retry: 3000");

    // An entry change on a key the page marks for Varda.
    const cookie = await live.signIn();
    const form = new FormData();
    form.set(
      "file",
      htmlFile(
        `<script type="application/json" id="portego-entries">${JSON.stringify({ keys: { "status:{item}": { varda: true } } })}</script>`,
      ),
    );
    form.set("title", "Review");
    const upload = await live.app.request("/api/artifacts", {
      method: "POST",
      headers: { cookie, origin: live.origin },
      body: form,
    });
    expect(upload.status).toBe(201);
    const { artifact } = (await upload.json()) as { artifact: { id: string } };
    const set = await live.app.request(`/api/artifacts/${artifact.id}/entries`, {
      method: "PUT",
      headers: { cookie, origin: live.origin, "content-type": "application/json" },
      body: JSON.stringify({ key: "status:I-01", value: "confirmed" }),
    });
    expect(set.status).toBe(200);
    await stream.until(3);
    expect(stream.rows().map((row) => row.id)).toEqual([first, second, second + 1]);
    expect(stream.rows()[2]?.data).toMatchObject({ artifactId: artifact.id, key: "status:I-01" });
    await stream.cancel();
  });

  test("acknowledged rows are not sent on the next connect", async () => {
    const first = insert({ type: "github", n: 1 });
    const second = insert({ type: "github", n: 2 });
    expect((await ack(varda.accessToken, { ids: [first, 999] })).status).toBe(204);
    expect((await ack(varda.accessToken, { ids: [] })).status).toBe(400);
    expect((await ack(varda.accessToken, { ids: [1.5] })).status).toBe(400);
    const stream = reader(await get(bearer(varda.accessToken)));
    await stream.until(1);
    expect(stream.rows().map((row) => row.id)).toEqual([second]);
    await stream.cancel();
  });

  test("a second stream closes the first", async () => {
    const first = reader(await get(bearer(varda.accessToken)));
    const second = reader(await get(bearer(varda.accessToken)));
    expect(await first.end()).toBe(true);
    insert({ type: "github", n: 1 });
    await second.until(1);
    await second.cancel();
  });

  test("rows older than 7 days are pruned at connect", async () => {
    const old = insert({ type: "github", n: 1 });
    const kept = insert({ type: "github", n: 2 });
    live.database
      .query("update vardaOutbox set createdAt = ? where id = ?")
      .run(Date.now() - RETENTION_MS - 1000, old);
    const stream = reader(await get(bearer(varda.accessToken)));
    await stream.until(1);
    expect(stream.rows().map((row) => row.id)).toEqual([kept]);
    expect(live.vardaOutbox.backlog().map((row) => row.id)).toEqual([kept]);
    await stream.cancel();
  });

  test("the stream closes at the token's exp", async () => {
    const [, payload = ""] = varda.accessToken.split(".");
    const { exp } = JSON.parse(Buffer.from(payload, "base64url").toString()) as { exp: number };
    shift = exp * 1000 - Date.now() - 200;
    const stream = reader(await get(bearer(varda.accessToken)));
    expect(await stream.end()).toBe(true);
  });
});

describe("with the integration off", () => {
  test("the stream is 404", async () => {
    const live = await createLiveTestServer();
    try {
      expect((await fetch(`${live.origin}/api/integrations/varda/stream`)).status).toBe(404);
    } finally {
      live.stop();
    }
  });
});
