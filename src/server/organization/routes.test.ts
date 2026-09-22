import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TEST_BASE_URL } from "../auth/testing.ts";
import { createTestServer, htmlFile, type TestServer } from "../testing.ts";

let server: TestServer;
let cookie: string;

beforeEach(async () => {
  server = await createTestServer();
  cookie = await server.signIn();
});

afterEach(() => {
  server.cleanup();
});

const jsonHeaders = { cookie: "", origin: TEST_BASE_URL, "content-type": "application/json" };

function headers() {
  return { ...jsonHeaders, cookie };
}

async function upload(title: string): Promise<string> {
  const form = new FormData();
  form.set("file", htmlFile("<p>x</p>"));
  form.set("title", title);
  const response = await server.app.request("/api/artifacts", {
    method: "POST",
    headers: { cookie, origin: TEST_BASE_URL },
    body: form,
  });
  const body = (await response.json()) as { artifact: { id: string } };
  return body.artifact.id;
}

async function createFolder(name: string, parentId?: string | null): Promise<string> {
  const response = await server.app.request("/api/folders", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ name, ...(parentId === undefined ? {} : { parentId }) }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { folder: { id: string } }).folder.id;
}

async function createTag(name: string): Promise<string> {
  const response = await server.app.request("/api/tags", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ name }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { tag: { id: string } }).tag.id;
}

describe("folders", () => {
  test("creates a nested, shared tree and prevents cycles", async () => {
    const parent = await createFolder("Research");
    const child = await createFolder("Experiments", parent);

    const folders = await server.app.request("/api/folders", { headers: { cookie } });
    await expect(folders.json()).resolves.toMatchObject({
      folders: [
        { id: child, name: "Experiments", parentId: parent, artifactCount: 0 },
        { id: parent, name: "Research", parentId: null, artifactCount: 0 },
      ],
    });

    const cycle = await server.app.request(`/api/folders/${parent}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ parentId: child }),
    });
    expect(cycle.status).toBe(400);
    await expect(cycle.json()).resolves.toMatchObject({ error: { code: "INVALID_INPUT" } });
  });

  test("moves direct artifacts to the parent and reparents children on deletion", async () => {
    const parent = await createFolder("Research");
    const child = await createFolder("Experiments", parent);
    const artifactId = await upload("Results");
    await server.app.request(`/api/artifacts/${artifactId}/organization`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ folderId: child }),
    });

    const deleted = await server.app.request(`/api/folders/${child}`, {
      method: "DELETE",
      headers: headers(),
    });
    expect(deleted.status).toBe(204);

    const artifact = await server.app.request(`/api/artifacts/${artifactId}`, {
      headers: { cookie },
    });
    await expect(artifact.json()).resolves.toMatchObject({
      artifact: { folder: { id: parent, name: "Research" }, tags: [] },
    });
  });

  test("keeps folder names unique among siblings, ignoring case", async () => {
    await createFolder("Research");
    const duplicate = await server.app.request("/api/folders", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ name: "research" }),
    });
    expect(duplicate.status).toBe(400);
  });
});

describe("tags and artifact organization", () => {
  test("assigns shared tags and one folder, while the default listing stays global", async () => {
    const folder = await createFolder("Research");
    const urgent = await createTag("Urgent");
    const client = await createTag("Client");
    const first = await upload("First");
    await upload("Second");

    const assigned = await server.app.request(`/api/artifacts/${first}/organization`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ folderId: folder, tagIds: [urgent, client] }),
    });
    expect(assigned.status).toBe(200);
    await expect(assigned.json()).resolves.toMatchObject({
      artifact: {
        folder: { id: folder, name: "Research" },
        tags: [
          { id: client, name: "Client" },
          { id: urgent, name: "Urgent" },
        ],
      },
    });

    const all = await server.app.request("/api/artifacts", { headers: { cookie } });
    expect(((await all.json()) as { items: unknown[] }).items).toHaveLength(2);

    const inFolder = await server.app.request(`/api/artifacts?folderId=${folder}`, {
      headers: { cookie },
    });
    await expect(inFolder.json()).resolves.toMatchObject({ items: [{ id: first }] });

    const allTags = await server.app.request(`/api/artifacts?tagId=${urgent}&tagId=${client}`, {
      headers: { cookie },
    });
    await expect(allTags.json()).resolves.toMatchObject({ items: [{ id: first }] });
  });

  test("can match any selected tag and rejects unknown or duplicate assignments", async () => {
    const firstTag = await createTag("One");
    const secondTag = await createTag("Two");
    const first = await upload("First");
    const second = await upload("Second");
    for (const [id, tagIds] of [
      [first, [firstTag]],
      [second, [secondTag]],
    ] as const) {
      await server.app.request(`/api/artifacts/${id}/organization`, {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({ tagIds }),
      });
    }

    const either = await server.app.request(
      `/api/artifacts?tagId=${firstTag}&tagId=${secondTag}&tagMatch=any`,
      { headers: { cookie } },
    );
    expect(((await either.json()) as { items: unknown[] }).items).toHaveLength(2);

    const duplicate = await server.app.request(`/api/artifacts/${first}/organization`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ tagIds: [firstTag, firstTag] }),
    });
    expect(duplicate.status).toBe(400);

    const unknown = await server.app.request(`/api/artifacts/${first}/organization`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ tagIds: ["missing"] }),
    });
    expect(unknown.status).toBe(404);
  });

  test("removes tag assignments without removing artifacts", async () => {
    const tag = await createTag("Urgent");
    const artifactId = await upload("First");
    await server.app.request(`/api/artifacts/${artifactId}/organization`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ tagIds: [tag] }),
    });

    const deleted = await server.app.request(`/api/tags/${tag}`, {
      method: "DELETE",
      headers: headers(),
    });
    expect(deleted.status).toBe(204);

    const artifact = await server.app.request(`/api/artifacts/${artifactId}`, {
      headers: { cookie },
    });
    await expect(artifact.json()).resolves.toMatchObject({ artifact: { tags: [] } });
  });
});

describe("organization authorization", () => {
  test("requires a session before a folder or tag lookup", async () => {
    for (const path of ["/api/folders", "/api/tags"]) {
      expect((await server.app.request(path)).status).toBe(401);
    }
  });
});
