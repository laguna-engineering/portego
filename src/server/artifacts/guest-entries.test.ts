import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TEST_BASE_URL } from "../auth/testing.ts";
import { createTestServer, htmlFile, type TestServer } from "../testing.ts";
import { GUEST_NAME_MAX_LENGTH } from "./service.ts";

let server: TestServer;
let cookie: string;

beforeEach(async () => {
  server = await createTestServer({ publicLinks: true });
  cookie = await server.signIn();
});

afterEach(() => {
  server.cleanup();
});

const SCHEMA = {
  keys: { "vote:{item}": { params: { item: { enum: ["P-01", "P-02"] } }, value: { const: true } } },
};

async function linked(title = "Backlog"): Promise<{ id: string; token: string }> {
  const form = new FormData();
  form.set(
    "file",
    htmlFile(
      `<!doctype html><title>${title}</title><script type="application/json" id="portego-entries">${JSON.stringify(SCHEMA)}</script><p>x</p>`,
    ),
  );
  form.set("title", title);
  const created = await server.app.request("/api/artifacts", {
    method: "POST",
    headers: { cookie, origin: TEST_BASE_URL },
    body: form,
  });
  const { artifact } = (await created.json()) as { artifact: { id: string } };
  const link = await server.app.request(`/api/artifacts/${artifact.id}/link`, {
    method: "POST",
    headers: { cookie, origin: TEST_BASE_URL },
  });
  const { url } = (await link.json()) as { url: string };
  return { id: artifact.id, token: url.split("/s/")[1] ?? "" };
}

async function join(token: string, name: unknown) {
  return server.app.request(`/api/shared/${token}/guest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

async function guest(token: string, name = "Visitor"): Promise<{ id: string; token: string }> {
  const res = await join(token, name);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { guest: { id: string }; token: string };
  return { id: body.guest.id, token: body.token };
}

function setGuestEntry(token: string, guestToken: string | null, key: string, value: unknown) {
  return server.app.request(`/api/shared/${token}/entries`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      ...(guestToken === null ? {} : { authorization: `Guest ${guestToken}` }),
    },
    body: JSON.stringify({ key, value }),
  });
}

function clearGuestEntry(token: string, guestToken: string, key: string) {
  return server.app.request(`/api/shared/${token}/entries?key=${encodeURIComponent(key)}`, {
    method: "DELETE",
    headers: { authorization: `Guest ${guestToken}` },
  });
}

type Listed = {
  entries: { key: string; author: { id: string; name: string; email?: string | null } }[];
};

async function publicEntries(token: string): Promise<Listed> {
  const res = await server.app.request(`/api/shared/${token}/entries`);
  expect(res.status).toBe(200);
  return (await res.json()) as Listed;
}

describe("guest entries", () => {
  test("a guest who gave a name adds an entry that members see under that name", async () => {
    const { id, token } = await linked();
    const visitor = await guest(token, "  Dana  ");
    expect((await setGuestEntry(token, visitor.token, "vote:P-01", true)).status).toBe(200);

    const members = await server.app.request(`/api/artifacts/${id}/entries`, {
      headers: { cookie },
    });
    expect(((await members.json()) as Listed).entries).toEqual([
      expect.objectContaining({
        key: "vote:P-01",
        author: { id: visitor.id, name: "Dana", email: null, guest: true },
      }),
    ]);
  });

  test("never show an outsider a member's email", async () => {
    const { id, token } = await linked();
    await server.app.request(`/api/artifacts/${id}/entries`, {
      method: "PUT",
      headers: { cookie, origin: TEST_BASE_URL, "content-type": "application/json" },
      body: JSON.stringify({ key: "vote:P-02", value: true }),
    });
    const listed = await publicEntries(token);
    expect(listed.entries).toHaveLength(1);
    expect(listed.entries[0]?.author).toEqual({ id: expect.any(String), name: "A Person" });
    expect(JSON.stringify(listed)).not.toContain("@acme.example");
  });

  test("refuses a write without a name, so every entry says who made it", async () => {
    const { token } = await linked();
    const res = await setGuestEntry(token, null, "vote:P-01", true);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
  });

  test("refuses a blank, overlong, or control-character name", async () => {
    const { token } = await linked();
    for (const name of ["", "   ", "x".repeat(GUEST_NAME_MAX_LENGTH + 1), "Dana‮", 42]) {
      expect((await join(token, name)).status).toBe(400);
    }
  });

  test("refuses a guest token from another artifact's link", async () => {
    const first = await linked("First");
    const second = await linked("Second");
    const visitor = await guest(first.token);
    const res = await setGuestEntry(second.token, visitor.token, "vote:P-01", true);
    expect(res.status).toBe(401);
  });

  test("refuses a forged guest token", async () => {
    const { token } = await linked();
    const visitor = await guest(token, "Dana");
    const [version, artifactId, guestId, , signature] = visitor.token.split(".");
    const renamed = Buffer.from("A Person", "utf8").toString("base64url");
    const forged = [version, artifactId, guestId, renamed, signature].join(".");
    expect((await setGuestEntry(token, forged, "vote:P-01", true)).status).toBe(401);
  });

  test("holds a guest to the artifact's entry schema", async () => {
    const { token } = await linked();
    const visitor = await guest(token);
    const res = await setGuestEntry(token, visitor.token, "vote:P-99", true);
    expect(res.status).toBe(400);
  });

  test("lets a guest clear only their own entry", async () => {
    const { token } = await linked();
    const first = await guest(token, "Dana");
    const second = await guest(token, "Eli");
    await setGuestEntry(token, first.token, "vote:P-01", true);
    await setGuestEntry(token, second.token, "vote:P-01", true);

    expect((await clearGuestEntry(token, second.token, "vote:P-01")).status).toBe(204);
    const names = (await publicEntries(token)).entries.map((entry) => entry.author.name);
    expect(names).toEqual(["Dana"]);
  });

  test("stops guest writes and reads once the link is revoked", async () => {
    const { id, token } = await linked();
    const visitor = await guest(token);
    await server.app.request(`/api/artifacts/${id}/link`, {
      method: "DELETE",
      headers: { cookie, origin: TEST_BASE_URL },
    });
    expect((await setGuestEntry(token, visitor.token, "vote:P-01", true)).status).toBe(404);
    expect((await server.app.request(`/api/shared/${token}/entries`)).status).toBe(404);
    expect((await join(token, "Late")).status).toBe(404);
  });
});
