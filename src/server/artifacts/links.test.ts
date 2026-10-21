import { afterEach, describe, expect, test } from "bun:test";
import { TEST_BASE_URL } from "../auth/testing.ts";
import { createMarkdownStore } from "../markdown/store.ts";
import { createArtifactStore } from "../storage/artifacts.ts";
import { createCommentStore } from "../storage/comments.ts";
import { createEntryStore } from "../storage/entries.ts";
import { createSearchStore } from "../storage/search.ts";
import { createTestServer, htmlFile, type TestServer, WORKSPACE_USER } from "../testing.ts";
import { createArtifactService } from "./service.ts";

let server: TestServer;
/** A Person, who creates the artifacts. */
let owner: string;
/** B Person, who is not their creator. */
let other: string;

async function start(options: { publicLinks?: boolean } = { publicLinks: true }) {
  server = await createTestServer(options);
  owner = await server.signIn();
  other = await server.signIn({
    ...WORKSPACE_USER,
    sub: "google-subject-2",
    email: "other@acme.example",
    name: "B Person",
  });
}

afterEach(() => {
  server.cleanup();
});

function request(cookie: string, path: string, init: { method?: string; body?: unknown } = {}) {
  return server.app.request(path, {
    method: init.method ?? "GET",
    headers: { cookie, origin: TEST_BASE_URL, "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

/** A request with no session, as a browser outside the company sends it. */
function anonymous(path: string) {
  return server.app.request(path);
}

async function upload(fields: Record<string, string> = {}): Promise<string> {
  const form = new FormData();
  form.set("file", htmlFile("<p>Quarterly plan</p>"));
  form.set("title", "Plan");
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  const res = await server.app.request("/api/artifacts", {
    method: "POST",
    headers: { cookie: owner, origin: TEST_BASE_URL },
    body: form,
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { artifact: { id: string } }).artifact.id;
}

async function createLink(id: string): Promise<string> {
  const res = await request(owner, `/api/artifacts/${id}/link`, { method: "POST" });
  expect(res.status).toBe(200);
  const { url } = (await res.json()) as { url: string };
  expect(url.startsWith(`${TEST_BASE_URL}/s/`)).toBe(true);
  return url.slice(`${TEST_BASE_URL}/s/`.length);
}

type SharedBody = {
  artifact: Record<string, unknown>;
  preview: { url: string; expiresAt: string };
};

describe("public links", () => {
  test("open the artifact without a session and show only what the page needs", async () => {
    await start();
    const id = await upload();
    const token = await createLink(id);

    const res = await anonymous(`/api/shared/${token}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SharedBody;
    expect(body.artifact).toEqual({
      title: "Plan",
      description: null,
      creator: { name: "A Person" },
      updatedAt: expect.any(String),
    });
    // The id and the creator's email would tell an outsider more than the link does.
    expect(JSON.stringify(body)).not.toContain(id);
    expect(JSON.stringify(body)).not.toContain("@acme.example");

    const page = await server.app.request(body.preview.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Quarterly plan");
  });

  test("tell a signed-in member which artifact it is, so they open it as a member", async () => {
    await start();
    const id = await upload();
    const token = await createLink(id);
    const res = await request(other, `/api/shared/${token}`);
    expect(await res.json()).toMatchObject({ artifactId: id });
  });

  test("keep the artifact in the company gallery, and make a private one shared", async () => {
    await start();
    const id = await upload({ visibility: "private" });
    await createLink(id);
    const res = await request(other, `/api/artifacts/${id}`);
    expect(await res.json()).toMatchObject({
      artifact: { visibility: "shared", publicLink: true },
    });
  });

  test("keep the same link when asked again, so a link already sent keeps working", async () => {
    await start();
    const id = await upload();
    expect(await createLink(id)).toBe(await createLink(id));
  });

  test("let any member who sees a shared artifact read, make, and revoke its link", async () => {
    await start();
    const id = await upload();
    const made = await request(other, `/api/artifacts/${id}/link`, { method: "POST" });
    expect(made.status).toBe(200);
    const { url } = (await made.json()) as { url: string };
    expect(await (await request(owner, `/api/artifacts/${id}/link`)).json()).toEqual({ url });

    const revoked = await request(other, `/api/artifacts/${id}/link`, { method: "DELETE" });
    expect(await revoked.json()).toMatchObject({
      artifact: { visibility: "shared", publicLink: false },
    });
    // Colleagues read the link from its route, never from a listing.
    const listed = await request(other, "/api/artifacts");
    expect(JSON.stringify(await listed.json())).not.toContain("shareToken");
  });

  test("leave a private artifact's link to its creator", async () => {
    await start();
    const id = await upload({ visibility: "private" });
    for (const method of ["GET", "POST", "DELETE"]) {
      const res = await request(other, `/api/artifacts/${id}/link`, { method });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: { code: "PRIVATE" } });
    }
  });

  test("tell the creator when someone else makes or revokes the link, whatever they follow", async () => {
    await start();
    const id = await upload();
    // The creator stops watching, so only the link rule can reach them.
    await request(owner, `/api/activity/subscriptions/artifacts/${id}`, {
      method: "PUT",
      body: { level: "none" },
    });
    await request(other, `/api/artifacts/${id}/link`, { method: "POST" });
    await request(other, `/api/artifacts/${id}/link`, { method: "DELETE" });

    const res = await request(owner, "/api/activity?scope=following");
    const { items } = (await res.json()) as {
      items: { kind: string; change?: string; actor: { name: string }; reason: unknown }[];
    };
    expect(
      items.map(({ kind, change, actor, reason }) => ({ kind, change, actor: actor.name, reason })),
    ).toEqual([
      { kind: "link.changed", change: "revoked", actor: "B Person", reason: { kind: "uploaded" } },
      { kind: "link.changed", change: "created", actor: "B Person", reason: { kind: "uploaded" } },
    ]);
  });

  test("record a link change only when the link appears or goes", async () => {
    await start();
    const id = await upload();
    await createLink(id);
    await createLink(id);
    await request(owner, `/api/artifacts/${id}/link`, { method: "DELETE" });
    await request(owner, `/api/artifacts/${id}/link`, { method: "DELETE" });
    const res = await request(other, "/api/activity?scope=everyone");
    const { items } = (await res.json()) as { items: { kind: string; change?: string }[] };
    expect(items.filter((item) => item.kind === "link.changed").map((item) => item.change)).toEqual(
      ["revoked", "created"],
    );
  });

  test("stop working when revoked, including a preview already issued", async () => {
    await start();
    const id = await upload();
    const token = await createLink(id);
    const { preview } = (await (await anonymous(`/api/shared/${token}`)).json()) as SharedBody;

    const revoked = await request(owner, `/api/artifacts/${id}/link`, { method: "DELETE" });
    expect(await revoked.json()).toMatchObject({
      artifact: { visibility: "shared", publicLink: false },
    });
    expect((await anonymous(`/api/shared/${token}`)).status).toBe(404);
    expect((await server.app.request(preview.url)).status).toBe(404);
    const link = await request(owner, `/api/artifacts/${id}/link`);
    expect(await link.json()).toEqual({ url: null });

    // A new link is a new secret, so the revoked one stays dead.
    expect(await createLink(id)).not.toBe(token);
    expect((await anonymous(`/api/shared/${token}`)).status).toBe(404);
  });

  test("stop working when the artifact is made private", async () => {
    await start();
    const id = await upload();
    const token = await createLink(id);
    await request(owner, `/api/artifacts/${id}/visibility`, {
      method: "PATCH",
      body: { visibility: "private" },
    });
    expect((await anonymous(`/api/shared/${token}`)).status).toBe(404);

    await request(owner, `/api/artifacts/${id}/visibility`, {
      method: "PATCH",
      body: { visibility: "shared" },
    });
    expect((await anonymous(`/api/shared/${token}`)).status).toBe(404);
  });

  test("stop working while the artifact is archived", async () => {
    await start();
    const id = await upload();
    const token = await createLink(id);
    await request(owner, `/api/artifacts/${id}/archived`, {
      method: "PATCH",
      body: { archived: true },
    });
    expect((await anonymous(`/api/shared/${token}`)).status).toBe(404);
    const archived = await request(other, `/api/artifacts/${id}`);
    expect(await archived.json()).toMatchObject({ artifact: { publicLink: false } });
  });

  test("answer an unknown link the same way as a revoked one", async () => {
    await start();
    const res = await anonymous("/api/shared/not-a-link");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "NOT_FOUND", message: "No such artifact." },
    });
  });
});

describe("with public links turned off", () => {
  test("refuses to create a link and reports the feature off", async () => {
    await start({});
    const id = await upload();
    const res = await request(owner, `/api/artifacts/${id}/link`, { method: "POST" });
    expect(res.status).toBe(403);
    const me = await request(owner, "/api/me");
    expect(await me.json()).toMatchObject({ features: { publicLinks: false } });
  });

  test("stops links made while it was on, and keeps them for when it is on again", async () => {
    await start();
    const id = await upload();
    const token = await createLink(id);
    const service = (publicLinks: boolean) =>
      createArtifactService({
        store: createArtifactStore({ database: server.database, dataDir: server.dataDir }),
        markdownStore: createMarkdownStore({ database: server.database }),
        commentStore: createCommentStore({ database: server.database }),
        entryStore: createEntryStore({ database: server.database }),
        searchStore: createSearchStore({ database: server.database }),
        publicLinks,
      });

    const off = service(false);
    expect(() => off.sharedArtifact(token)).toThrow("No such artifact.");
    expect(off.get(id, { userId: null }).publicLink).toBe(false);
    expect(service(true).sharedArtifact(token).id).toBe(id);
  });
});
