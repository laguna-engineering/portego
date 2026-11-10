import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TEST_BASE_URL } from "../auth/testing.ts";
import type { VardaRow } from "../storage/varda-outbox.ts";
import { createTestServer, htmlFile, type TestServer, VARDA_USER } from "../testing.ts";

let server: TestServer;
let cookie: string;

afterEach(() => {
  server.cleanup();
});

const MARKED = {
  keys: {
    "status:{item}": { value: { enum: ["confirmed", "wrong"] }, varda: true },
    "viewer:{item}": { value: { const: true } },
  },
};
const UNMARKED = {
  keys: {
    "status:{item}": { value: { enum: ["confirmed", "wrong"] } },
    "viewer:{item}": { value: { const: true } },
  },
};

function page(schema: unknown): string {
  return `<!doctype html><html><head><title>Review</title><script type="application/json" id="portego-entries">${JSON.stringify(schema)}</script></head><body><p>x</p></body></html>`;
}

function upload(html: string, fields: Record<string, string> = {}, sessionCookie = cookie) {
  const form = new FormData();
  form.set("file", htmlFile(html));
  form.set("title", "Review");
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  return server.app.request("/api/artifacts", {
    method: "POST",
    headers: { cookie: sessionCookie, origin: TEST_BASE_URL },
    body: form,
  });
}

async function uploaded(
  schema: unknown,
  fields: Record<string, string> = {},
  sessionCookie = cookie,
): Promise<string> {
  const res = await upload(page(schema), fields, sessionCookie);
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

function clearEntry(id: string, key: string) {
  return server.app.request(`/api/artifacts/${id}/entries?key=${encodeURIComponent(key)}`, {
    method: "DELETE",
    headers: { cookie, origin: TEST_BASE_URL },
  });
}

const rows = () => server.vardaOutbox.backlog().map((row) => JSON.parse(row.data));

describe("with the Varda integration on", () => {
  beforeEach(async () => {
    server = await createTestServer({ varda: {}, publicLinks: true });
    cookie = await server.signIn();
  });

  test("a set on a marked key writes one row with the key and set, and announces it", async () => {
    const announced: VardaRow[] = [];
    server.vardaOutbox.onRow((row) => announced.push(row));
    const id = await uploaded(MARKED);
    expect((await setEntry(id, "status:I-03", "confirmed")).status).toBe(200);
    expect(rows()).toEqual([
      { type: "entry", artifactId: id, key: "status:I-03", change: "set", at: expect.any(String) },
    ]);
    expect(announced).toEqual(server.vardaOutbox.backlog());
  });

  test("the same value again writes nothing", async () => {
    const id = await uploaded(MARKED);
    await setEntry(id, "status:I-03", "confirmed");
    await setEntry(id, "status:I-03", "confirmed");
    expect(rows()).toHaveLength(1);
  });

  test("a different value writes one more row", async () => {
    const id = await uploaded(MARKED);
    await setEntry(id, "status:I-03", "confirmed");
    await setEntry(id, "status:I-03", "wrong");
    expect(rows().map((row) => row.change)).toEqual(["set", "set"]);
  });

  test("a clear of an existing key writes one clear row; a clear of a missing key writes nothing", async () => {
    const id = await uploaded(MARKED);
    await setEntry(id, "status:I-03", "confirmed");
    expect((await clearEntry(id, "status:I-03")).status).toBe(204);
    expect((await clearEntry(id, "status:I-03")).status).toBe(204);
    expect((await clearEntry(id, "status:I-04")).status).toBe(204);
    expect(rows().map((row) => `${row.key} ${row.change}`)).toEqual([
      "status:I-03 set",
      "status:I-03 clear",
    ]);
  });

  test("an unmarked key writes nothing", async () => {
    const id = await uploaded(MARKED);
    expect((await setEntry(id, "viewer:I-03", true)).status).toBe(200);
    expect(rows()).toEqual([]);
  });

  test("a private artifact of another user writes nothing; one Varda's account created does", async () => {
    const hidden = await uploaded(MARKED, { visibility: "private" });
    expect((await setEntry(hidden, "status:I-03", "confirmed")).status).toBe(200);
    expect(rows()).toEqual([]);

    const varda = await server.signIn(VARDA_USER);
    const own = await uploaded(MARKED, { visibility: "private" }, varda);
    expect((await setEntry(own, "status:I-03", "confirmed", varda)).status).toBe(200);
    expect(rows().map((row) => row.artifactId)).toEqual([own]);
  });

  test("a rule marked only in an older version writes nothing", async () => {
    const id = await uploaded(MARKED);
    expect((await upload(page(UNMARKED), { artifactId: id })).status).toBe(201);
    expect((await setEntry(id, "status:I-03", "confirmed")).status).toBe(200);
    expect(rows()).toEqual([]);
  });

  test("a guest write and a guest clear on a marked key write one row each", async () => {
    const id = await uploaded(MARKED);
    const link = await server.app.request(`/api/artifacts/${id}/link`, {
      method: "POST",
      headers: { cookie, origin: TEST_BASE_URL },
    });
    const token = ((await link.json()) as { url: string }).url.split("/s/")[1] ?? "";
    const joined = await server.app.request(`/api/shared/${token}/guest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Visitor" }),
    });
    const guest = ((await joined.json()) as { token: string }).token;
    const set = await server.app.request(`/api/shared/${token}/entries`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Guest ${guest}` },
      body: JSON.stringify({ key: "status:I-03", value: "confirmed" }),
    });
    expect(set.status).toBe(200);
    const cleared = await server.app.request(`/api/shared/${token}/entries?key=status%3AI-03`, {
      method: "DELETE",
      headers: { authorization: `Guest ${guest}` },
    });
    expect(cleared.status).toBe(204);
    expect(rows().map((row) => `${row.artifactId} ${row.key} ${row.change}`)).toEqual([
      `${id} status:I-03 set`,
      `${id} status:I-03 clear`,
    ]);
  });

  test("a write that fails its checks writes no row and announces nothing", async () => {
    const announced: VardaRow[] = [];
    server.vardaOutbox.onRow((row) => announced.push(row));
    const id = await uploaded(MARKED);
    expect((await setEntry(id, "status:I-03", "maybe")).status).toBe(400);
    expect(rows()).toEqual([]);
    expect(announced).toEqual([]);
  });

  test("an entry whose outbox row cannot be written is not written either", async () => {
    const id = await uploaded(MARKED);
    server.database.exec("drop table vardaOutbox");
    expect((await setEntry(id, "status:I-03", "confirmed")).status).toBe(500);
    const list = await server.app.request(`/api/artifacts/${id}/entries`, { headers: { cookie } });
    expect(((await list.json()) as { entries: unknown[] }).entries).toEqual([]);
  });

  test("an upload whose schema marks keys for Varda is accepted", async () => {
    expect((await upload(page(MARKED))).status).toBe(201);
  });
});

describe("with the Varda integration off", () => {
  beforeEach(async () => {
    server = await createTestServer();
    cookie = await server.signIn();
  });

  test("an upload with varda is refused, and stored schemas with it still parse", async () => {
    const res = await upload(page(MARKED));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
      'The portego-entries schema: status:{item}: "varda" needs the Varda integration, which this deployment does not have.',
    );

    // A schema stored while the integration was on, on the artifact's only version.
    const id = await uploaded(UNMARKED);
    server.database
      .query("update artifactVersions set entrySchema = ? where artifactId = ?")
      .run(JSON.stringify(MARKED), id);
    expect((await setEntry(id, "status:I-03", "confirmed")).status).toBe(200);
    expect(rows()).toEqual([]);
  });
});
