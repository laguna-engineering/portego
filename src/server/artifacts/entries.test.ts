import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TEST_BASE_URL } from "../auth/testing.ts";
import type { ChangeEvent } from "../events/bus.ts";
import { createTestServer, htmlFile, type TestServer } from "../testing.ts";
import {
  ENTRIES_PER_AUTHOR,
  ENTRY_VALUE_MAX_BYTES,
  ENTRY_VALUES_MAX_BYTES,
  ENTRY_WRITES_PER_MINUTE,
} from "./service.ts";

let server: TestServer;
let cookie: string;

beforeEach(async () => {
  server = await createTestServer();
  cookie = await server.signIn();
});

afterEach(() => {
  server.cleanup();
});

const SCHEMA = {
  keys: {
    "vote:{item}": { params: { item: { enum: ["P-01", "P-02"] } }, value: { const: true } },
  },
};

function page(schema?: unknown): string {
  const block = schema
    ? `<script type="application/json" id="portego-entries">${JSON.stringify(schema)}</script>`
    : "";
  return `<!doctype html><html><head><title>Backlog</title>${block}</head><body><p>x</p></body></html>`;
}

async function upload(html: string, title = "Backlog") {
  const form = new FormData();
  form.set("file", htmlFile(html));
  form.set("title", title);
  return server.app.request("/api/artifacts", {
    method: "POST",
    headers: { cookie, origin: TEST_BASE_URL },
    body: form,
  });
}

async function uploaded(html: string): Promise<string> {
  const res = await upload(html);
  expect(res.status).toBe(201);
  return ((await res.json()) as { artifact: { id: string } }).artifact.id;
}

function setEntry(id: string, key: string, value: unknown, sessionCookie = cookie) {
  return server.app.request(`/api/artifacts/${id}/entries`, {
    method: "PUT",
    headers: { cookie: sessionCookie, origin: TEST_BASE_URL, "content-type": "application/json" },
    body: JSON.stringify({ key, value }),
  });
}

function clearEntry(id: string, key: string, sessionCookie = cookie) {
  return server.app.request(`/api/artifacts/${id}/entries?key=${encodeURIComponent(key)}`, {
    method: "DELETE",
    headers: { cookie: sessionCookie, origin: TEST_BASE_URL },
  });
}

type Listed = {
  entries: { key: string; value: unknown; author: { id: string; name: string } }[];
  schema: unknown;
};

async function listEntries(id: string): Promise<Listed> {
  const res = await server.app.request(`/api/artifacts/${id}/entries`, { headers: { cookie } });
  expect(res.status).toBe(200);
  return (await res.json()) as Listed;
}

/** Stores rows directly: the per-minute limit would stop this many writes through the API. */
function store(id: string, email: string, rows: [key: string, json: string][]) {
  const { id: authorId } = server.database
    .query('select id from "user" where email = ?')
    .get(email) as { id: string };
  const insert = server.database.query(
    "insert into artifactEntries (artifactId, authorId, key, value, updatedAt) values (?, ?, ?, ?, ?)",
  );
  for (const [key, json] of rows) insert.run(id, authorId, key, json, Date.now());
}

function otherPerson() {
  return server.signIn({
    sub: "google-subject-2",
    email: "other@acme.example",
    email_verified: true,
    name: "Another Person",
  });
}

describe("entries", () => {
  test("keep one value per person per key, so a second vote replaces the first", async () => {
    const id = await uploaded(page());
    expect((await setEntry(id, "poll", "A")).status).toBe(200);
    expect((await setEntry(id, "poll", "B")).status).toBe(200);
    const other = await otherPerson();
    expect((await setEntry(id, "poll", "A", other)).status).toBe(200);

    const { entries } = await listEntries(id);
    expect(entries.map((entry) => [entry.author.name, entry.value])).toEqual([
      ["A Person", "B"],
      ["Another Person", "A"],
    ]);
  });

  test("clearing removes only the caller's own value", async () => {
    const id = await uploaded(page());
    await setEntry(id, "poll", "A");
    const other = await otherPerson();
    await setEntry(id, "poll", "B", other);

    expect((await clearEntry(id, "poll", other)).status).toBe(204);
    // Clearing again is not an error: the value is already gone.
    expect((await clearEntry(id, "poll", other)).status).toBe(204);

    const { entries } = await listEntries(id);
    expect(entries.map((entry) => entry.value)).toEqual(["A"]);
  });

  test("announce each change so open pages refetch", async () => {
    const id = await uploaded(page());
    const seen: ChangeEvent[] = [];
    const unsubscribe = server.events.subscribe((event) => seen.push(event));
    await setEntry(id, "poll", "A");
    await clearEntry(id, "poll");
    // Nothing was there to clear, so nothing changed and nothing is announced.
    await clearEntry(id, "poll");
    unsubscribe();
    expect(seen).toEqual([
      { type: "entry.changed", artifactId: id },
      { type: "entry.changed", artifactId: id },
    ]);
  });

  test("refuse a malformed key or an oversized value", async () => {
    const id = await uploaded(page());
    expect((await setEntry(id, "two words", 1)).status).toBe(400);
    expect((await setEntry(id, "x".repeat(201), 1)).status).toBe(400);
    const big = "x".repeat(ENTRY_VALUE_MAX_BYTES);
    const res = await setEntry(id, "note", big);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
      `${ENTRY_VALUE_MAX_BYTES} bytes`,
    );
  });

  test("refuse writes past the per-minute limit, so a page cannot flood the store", async () => {
    const id = await uploaded(page());
    for (let index = 0; index < ENTRY_WRITES_PER_MINUTE; index++) {
      expect((await setEntry(id, "counter", index)).status).toBe(200);
    }
    const res = await setEntry(id, "counter", -1);
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("RATE_LIMITED");
    // The limit is per person: someone else can still write.
    expect((await setEntry(id, "counter", 0, await otherPerson())).status).toBe(200);
  });

  test("refuse a new key past the per-person limit, but still let a person change a key they hold", async () => {
    const id = await uploaded(page());
    const keys = Array.from({ length: ENTRIES_PER_AUTHOR }, (_, index): [string, string] => [
      `k${index}`,
      "1",
    ]);
    store(id, "person@acme.example", keys);

    const res = await setEntry(id, "one-more", 1);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
      `${ENTRIES_PER_AUTHOR} entries`,
    );
    expect((await setEntry(id, "k0", 2)).status).toBe(200);
    // Another person has their own allowance.
    expect((await setEntry(id, "one-more", 1, await otherPerson())).status).toBe(200);
  });

  test("keep an artifact's values under a total size, so its list fits in one response", async () => {
    const id = await uploaded(page());
    await otherPerson();
    const room = 100;
    store(id, "other@acme.example", [
      ["bulk", JSON.stringify("x".repeat(ENTRY_VALUES_MAX_BYTES - room - 2))],
    ]);

    // A value's JSON is its length plus two quotes.
    expect((await setEntry(id, "note", "x".repeat(40))).status).toBe(200);
    // Replacing a value frees the old one's bytes first.
    expect((await setEntry(id, "note", "x".repeat(room - 2))).status).toBe(200);
    const res = await setEntry(id, "note", "x".repeat(room - 1));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
      `${ENTRY_VALUES_MAX_BYTES} bytes`,
    );
  });

  test("answer 404 for an artifact that does not exist", async () => {
    expect((await setEntry("missing", "poll", "A")).status).toBe(404);
  });
});

describe("an artifact's entry schema", () => {
  test("is returned with the entries, so an agent learns the format without reading the page", async () => {
    const id = await uploaded(page(SCHEMA));
    expect((await listEntries(id)).schema).toEqual(SCHEMA);
  });

  test("refuses entries that do not fit and says why", async () => {
    const id = await uploaded(page(SCHEMA));
    expect((await setEntry(id, "vote:P-01", true)).status).toBe(200);

    const res = await setEntry(id, "vote:P-99", true);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
      "{item} must be one of",
    );
    expect((await setEntry(id, "poll", "A")).status).toBe(400);
  });

  test("comes from the current version, and a version without one accepts any key", async () => {
    const id = await uploaded(page(SCHEMA));
    await uploaded(page());
    expect((await listEntries(id)).schema).toBeNull();
    expect((await setEntry(id, "poll", "A")).status).toBe(200);
  });

  test("that is broken refuses the upload, so the author finds out before anyone writes", async () => {
    const res = await upload(
      page({ keys: { "vote:{item}": { params: { item: { pattern: "^P" } } } } }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("portego-entries");
    expect(body.error.message).toContain('"pattern" is not supported');
    const count = server.database.query("select count(*) as n from artifacts").get() as {
      n: number;
    };
    expect(count.n).toBe(0);
  });
});
