import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createTestServer, type TestServer } from "../testing.ts";
import { WEBHOOK_MAX_BYTES } from "./routes.ts";

const SECRET = "w".repeat(40);

let server: TestServer;

afterEach(() => {
  server.cleanup();
});

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
