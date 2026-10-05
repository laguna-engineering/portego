import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mintUploadTicket } from "../artifacts/tickets.ts";
import { TEST_BASE_URL } from "../auth/testing.ts";
import { createActivityStore } from "../storage/activity.ts";
import { createArtifactStore } from "../storage/artifacts.ts";
import { createTestServer, htmlFile, type TestServer, WORKSPACE_USER } from "../testing.ts";
import { ACTIVITY_WINDOW_MS } from "./routes.ts";

let server: TestServer;
/** A Person, who does things in the web app. */
let cookie: string;
/** B Person, who reads about them. */
let reader: string;

beforeEach(async () => {
  server = await createTestServer();
  cookie = await server.signIn();
  reader = await server.signIn({
    ...WORKSPACE_USER,
    sub: "google-subject-2",
    email: "other@acme.example",
    name: "B Person",
  });
});

afterEach(() => {
  server.cleanup();
});

const DAY_MS = 24 * 60 * 60 * 1000;

type Item = {
  id: string;
  kind: string;
  createdAt: string;
  actor: { id: string; name: string };
  artifact: { id: string; title: string };
  versionNumber?: number;
  reply?: boolean;
  change?: string;
  key?: string;
};

function send(method: string, path: string, body: unknown) {
  return server.app.request(path, {
    method,
    headers: { cookie, origin: TEST_BASE_URL, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function upload(title: string, artifactId?: string, html = "<p>x</p>"): Promise<string> {
  const form = new FormData();
  form.set("file", htmlFile(html));
  form.set("title", title);
  if (artifactId) form.set("artifactId", artifactId);
  const res = await server.app.request("/api/artifacts", {
    method: "POST",
    headers: { cookie, origin: TEST_BASE_URL },
    body: form,
  });
  expect(res.status).toBeLessThan(300);
  return ((await res.json()) as { artifact: { id: string } }).artifact.id;
}

async function comment(artifactId: string, body: string, parentId?: string): Promise<string> {
  const res = await send("POST", `/api/artifacts/${artifactId}/comments`, { body, parentId });
  expect(res.status).toBe(201);
  return ((await res.json()) as { comment: { id: string } }).comment.id;
}

async function userId(sessionCookie: string): Promise<string> {
  const session = await server.auth.api.getSession({
    headers: new Headers({ cookie: sessionCookie }),
  });
  return session?.user.id ?? "";
}

async function feed(sessionCookie = reader): Promise<{ items: Item[]; readAt: string | null }> {
  const res = await server.app.request("/api/activity", { headers: { cookie: sessionCookie } });
  expect(res.status).toBe(200);
  return (await res.json()) as { items: Item[]; readAt: string | null };
}

/** What a reader of the menu would be told, without ids and times. */
function told(item: Item): string {
  const detail =
    item.kind === "version.created"
      ? ` v${item.versionNumber}`
      : item.kind === "comment.created"
        ? item.reply
          ? " reply"
          : " root"
        : item.kind === "status.changed"
          ? ` ${item.change}`
          : item.kind === "entry.changed"
            ? ` ${item.key}`
            : "";
  return `${item.actor.name} ${item.kind}${detail} on ${item.artifact.title}`;
}

describe("feed", () => {
  test("lists new artifacts, versions, comments, and status changes, with who and where", async () => {
    const id = await upload("Plan");
    await upload("Plan", id);
    const root = await comment(id, "Looks right");
    await comment(id, "Agreed", root);
    await send("PATCH", `/api/artifacts/${id}/status`, { status: "solved" });
    await send("PATCH", `/api/artifacts/${id}/status`, { status: "open" });
    await send("PATCH", `/api/artifacts/${id}/archived`, { archived: true });
    await send("PATCH", `/api/artifacts/${id}/archived`, { archived: false });

    const { items } = await feed();

    expect(items.map(told).sort()).toEqual(
      [
        "A Person artifact.created on Plan",
        "A Person version.created v2 on Plan",
        "A Person comment.created root on Plan",
        "A Person comment.created reply on Plan",
        "A Person status.changed solved on Plan",
        "A Person status.changed reopened on Plan",
        "A Person status.changed archived on Plan",
        "A Person status.changed restored on Plan",
      ].sort(),
    );
  });

  test("puts the newest first", async () => {
    const id = await upload("Plan");
    const first = await comment(id, "First");
    const second = await comment(id, "Second");
    const now = Date.now();
    const setAt = server.database.query("update artifactComments set createdAt = ? where id = ?");
    setAt.run(now - 2000, first);
    setAt.run(now - 1000, second);
    server.database.query("update artifactVersions set createdAt = ?").run(now - 3000);

    const { items } = await feed();

    expect(items.map((item) => item.id)).toEqual([second, first, id]);
  });

  test("records a status change only when the status actually changes", async () => {
    const id = await upload("Plan");
    await send("PATCH", `/api/artifacts/${id}/status`, { status: "solved" });
    await send("PATCH", `/api/artifacts/${id}/status`, { status: "solved" });
    await send("PATCH", `/api/artifacts/${id}/archived`, { archived: false });

    const { items } = await feed();

    expect(items.filter((item) => item.kind === "status.changed").map(told)).toEqual([
      "A Person status.changed solved on Plan",
    ]);
  });

  test("leaves out anything older than the window", async () => {
    const id = await upload("Plan");
    const old = await comment(id, "Last week");
    const recent = await comment(id, "This week");
    const now = Date.now();
    const setAt = server.database.query("update artifactComments set createdAt = ? where id = ?");
    setAt.run(now - ACTIVITY_WINDOW_MS - DAY_MS, old);
    setAt.run(now - ACTIVITY_WINDOW_MS + DAY_MS, recent);

    const ids = (await feed()).items.map((item) => item.id);

    expect(ids).toContain(recent);
    expect(ids).not.toContain(old);
  });

  test("drops a comment once it is removed", async () => {
    const id = await upload("Plan");
    const removed = await comment(id, "Oops");
    await server.app.request(`/api/artifacts/${id}/comments/${removed}`, {
      method: "DELETE",
      headers: { cookie, origin: TEST_BASE_URL },
    });

    expect((await feed()).items.map((item) => item.id)).not.toContain(removed);
  });

  test("keeps the status history of an artifact merged into another", async () => {
    const into = await upload("Plan");
    const from = await upload("Plan, again");
    await send("PATCH", `/api/artifacts/${from}/status`, { status: "solved" });

    createArtifactStore({ database: server.database, dataDir: server.dataDir }).mergeInto(
      into,
      from,
    );

    const changes = (await feed()).items.filter((item) => item.kind === "status.changed");
    expect(changes.map(told)).toEqual(["A Person status.changed solved on Plan"]);
  });

  test("leaves out what the reader did in the web app, and only for them", async () => {
    const id = await upload("Plan");
    await upload("Plan", id);
    await comment(id, "Looks right");
    await send("PATCH", `/api/artifacts/${id}/status`, { status: "solved" });
    await send("PATCH", `/api/artifacts/${id}/archived`, { archived: true });

    expect((await feed(cookie)).items).toEqual([]);
    expect((await feed(reader)).items.map(told).sort()).toEqual(
      [
        "A Person artifact.created on Plan",
        "A Person version.created v2 on Plan",
        "A Person comment.created root on Plan",
        "A Person status.changed solved on Plan",
        "A Person status.changed archived on Plan",
      ].sort(),
    );
  });

  test("keeps what the reader's agent did under their account", async () => {
    const { ticket } = mintUploadTicket(server.signingSecret, await userId(cookie));
    const form = new FormData();
    form.set("file", htmlFile("<p>x</p>"));
    form.set("title", "Plan");
    const res = await server.app.request("/api/uploads", {
      method: "POST",
      headers: { authorization: `Bearer ${ticket}` },
      body: form,
    });
    const id = ((await res.json()) as { artifact: { id: string } }).artifact.id;
    // The MCP tools call the service directly, without the web app's flag.
    server.artifacts.addComment(id, { authorId: await userId(cookie), body: "Done" });
    server.artifacts.setStatus(id, "solved", await userId(cookie));

    expect((await feed(cookie)).items.map(told).sort()).toEqual(
      [
        "A Person artifact.created on Plan",
        "A Person comment.created root on Plan",
        "A Person status.changed solved on Plan",
      ].sort(),
    );
  });

  test("requires a signed-in user", async () => {
    expect((await server.app.request("/api/activity")).status).toBe(401);
  });
});

describe("entries", () => {
  const SCHEMA = {
    keys: {
      "note:{item}": { value: { type: "string", format: "comment" } },
      "quiet:{item}": { notify: false, value: { type: "string", format: "comment" } },
      "vote:{item}": { value: { enum: ["up", "down"] } },
      "pick:{item}": { notify: true, value: { enum: ["A", "B"] } },
    },
  };
  const PAGE = `<script type="application/json" id="portego-entries">${JSON.stringify(SCHEMA)}</script>`;

  const page = () => upload("Board", undefined, PAGE);

  async function write(artifactId: string, key: string, value: unknown) {
    const res = await send("PUT", `/api/artifacts/${artifactId}/entries`, { key, value });
    expect(res.status).toBe(200);
  }

  const entryItems = async (sessionCookie = reader) =>
    (await feed(sessionCookie)).items.filter((item) => item.kind === "entry.changed");

  test("lists text written like a comment and keys the page opts in, and nothing else", async () => {
    const id = await page();
    await write(id, "note:P-01", "Needs a test");
    await write(id, "quiet:P-01", "Seen it");
    await write(id, "vote:P-01", "up");
    await write(id, "pick:P-01", "A");

    expect((await entryItems()).map(told).sort()).toEqual(
      [
        "A Person entry.changed note:P-01 on Board",
        "A Person entry.changed pick:P-01 on Board",
      ].sort(),
    );
  });

  test("moves an entry up under a new id when its value changes, but not when the same value is written again", async () => {
    const id = await page();
    await write(id, "note:P-01", "First");
    const at = Date.now() - 60_000;
    server.database.query("update artifactEntries set notifiedAt = ?").run(at);

    const [first] = await entryItems();

    await write(id, "note:P-01", "First");
    const [same] = await entryItems();
    expect(same?.id).toBe(first?.id);
    expect(Date.parse(same?.createdAt ?? "")).toBe(at);

    // A new id tells a client that has seen the first value that this one is new.
    await write(id, "note:P-01", "Second");
    const items = await entryItems();
    expect(items).toHaveLength(1);
    expect(items[0]?.id).not.toBe(first?.id);
    expect(Date.parse(items[0]?.createdAt ?? "")).toBeGreaterThan(at);
  });

  test("drops an entry once it is cleared", async () => {
    const id = await page();
    await write(id, "note:P-01", "Oops");
    await server.app.request(`/api/artifacts/${id}/entries?key=note:P-01`, {
      method: "DELETE",
      headers: { cookie, origin: TEST_BASE_URL },
    });

    expect(await entryItems()).toEqual([]);
  });

  test("leaves out what the reader wrote in the page, but keeps what their agent wrote", async () => {
    const id = await page();
    await write(id, "note:P-01", "From the page");
    expect(await entryItems(cookie)).toEqual([]);

    // The MCP tools call the service directly, without the web app's flag.
    server.artifacts.setEntry(id, { authorId: await userId(cookie), key: "note:P-02", value: "x" });
    expect((await entryItems(cookie)).map(told)).toEqual([
      "A Person entry.changed note:P-02 on Board",
    ]);
  });

  test("announces which changes reach the feed, so open bells reload only for those", async () => {
    const id = await page();
    const events: unknown[] = [];
    const stop = server.events.subscribe((event) => events.push(event));
    await write(id, "vote:P-01", "up");
    await write(id, "note:P-01", "Hello");
    await write(id, "note:P-01", "Hello");
    stop();

    expect(events).toEqual([
      { type: "entry.changed", artifactId: id },
      { type: "entry.changed", artifactId: id, activity: true },
      { type: "entry.changed", artifactId: id },
    ]);
  });
});

describe("read marker", () => {
  test("starts unset, is set on read, and belongs to one person", async () => {
    expect((await feed(cookie)).readAt).toBeNull();

    const res = await send("POST", "/api/activity/read", {});
    expect(res.status).toBe(200);
    const { readAt } = (await res.json()) as { readAt: string };

    expect((await feed(cookie)).readAt).toBe(readAt);
    expect((await feed(reader)).readAt).toBeNull();
  });

  test("never moves back, so a slow request cannot mark read items unread again", async () => {
    const store = createActivityStore({ database: server.database });
    const id = await userId(cookie);

    store.markRead(id, 2000);
    store.markRead(id, 1000);

    expect(store.readAt(id)?.getTime()).toBe(2000);
  });
});
