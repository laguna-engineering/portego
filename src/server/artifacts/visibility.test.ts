import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TEST_BASE_URL } from "../auth/testing.ts";
import { createMarkdownStore } from "../markdown/store.ts";
import { createArtifactStore } from "../storage/artifacts.ts";
import { createCommentStore } from "../storage/comments.ts";
import { createEntryStore } from "../storage/entries.ts";
import {
  createTestServer,
  htmlFile,
  TEST_CONTENT_ORIGIN,
  type TestServer,
  WORKSPACE_USER,
} from "../testing.ts";

import { createArtifactService } from "./service.ts";

let server: TestServer;
/** A Person, who creates the artifacts. */
let owner: string;
/** B Person, who is not their creator. */
let other: string;

beforeEach(async () => {
  server = await createTestServer();
  owner = await server.signIn();
  other = await server.signIn({
    ...WORKSPACE_USER,
    sub: "google-subject-2",
    email: "other@acme.example",
    name: "B Person",
  });
});

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

function uploadForm(cookie: string, fields: Record<string, string>) {
  const form = new FormData();
  form.set("file", htmlFile("<p>x</p>"));
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  return server.app.request("/api/artifacts", {
    method: "POST",
    headers: { cookie, origin: TEST_BASE_URL },
    body: form,
  });
}

async function upload(title: string, fields: Record<string, string> = {}): Promise<string> {
  const res = await uploadForm(owner, { title, ...fields });
  expect(res.status).toBe(201);
  return ((await res.json()) as { artifact: { id: string } }).artifact.id;
}

function setVisibility(cookie: string, id: string, visibility: unknown) {
  return request(cookie, `/api/artifacts/${id}/visibility`, {
    method: "PATCH",
    body: { visibility },
  });
}

async function listedTitles(cookie: string): Promise<string[]> {
  const res = await request(cookie, "/api/artifacts");
  return ((await res.json()) as { items: { title: string }[] }).items.map((item) => item.title);
}

describe("changing visibility", () => {
  test("new artifacts are shared, and the creator can make one private and shared again", async () => {
    const id = await upload("Plan");
    const shared = await request(owner, `/api/artifacts/${id}`);
    expect(
      ((await shared.json()) as { artifact: { visibility: string } }).artifact.visibility,
    ).toBe("shared");

    const hidden = await setVisibility(owner, id, "private");
    expect(hidden.status).toBe(200);
    expect(await hidden.json()).toMatchObject({ artifact: { visibility: "private" } });
    expect((await request(other, `/api/artifacts/${id}`)).status).toBe(403);

    const reshared = await setVisibility(owner, id, "shared");
    expect(await reshared.json()).toMatchObject({ artifact: { visibility: "shared" } });
    expect((await request(other, `/api/artifacts/${id}`)).status).toBe(200);
  });

  test("refuses anyone but the creator, so a shared artifact cannot be taken private", async () => {
    const id = await upload("Plan");
    const res = await setVisibility(other, id, "private");
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "FORBIDDEN" } });
    expect((await request(other, `/api/artifacts/${id}`)).status).toBe(200);
  });

  test("refuses a visibility this application does not define", async () => {
    const id = await upload("Plan");
    const res = await setVisibility(owner, id, "secret");
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "INVALID_INPUT" } });
  });

  test("an upload can create a private artifact directly", async () => {
    const id = await upload("Draft", { visibility: "private" });
    expect(await listedTitles(owner)).toEqual(["Draft"]);
    expect(await listedTitles(other)).toEqual([]);
    expect((await request(other, `/api/artifacts/${id}`)).status).toBe(403);
  });

  test("a new version can change visibility only for the creator", async () => {
    const id = await upload("Plan");
    const res = await uploadForm(other, { title: "Plan", artifactId: id, visibility: "private" });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "FORBIDDEN" } });
    expect((await request(other, `/api/artifacts/${id}`)).status).toBe(200);
  });
});

describe("someone else's private artifact", () => {
  let id: string;

  beforeEach(async () => {
    id = await upload("Salary review", { description: "Numbers for the leads only" });
    expect((await setVisibility(owner, id, "private")).status).toBe(200);
  });

  // The page a non-creator sees says the artifact is private and nothing else,
  // so the refusal carries no title, description, or creator.
  test("every artifact route refuses with PRIVATE and says nothing about the artifact", async () => {
    const attempts: [string, string, unknown?][] = [
      ["GET", `/api/artifacts/${id}`],
      ["GET", `/api/artifacts/${id}/versions`],
      ["GET", `/api/artifacts/${id}/comments`],
      ["GET", `/api/artifacts/${id}/entries`],
      ["GET", `/api/artifacts/${id}/markdown`],
      ["GET", `/api/artifacts/${id}/source`],
      ["POST", `/api/artifacts/${id}/preview`],
      ["PATCH", `/api/artifacts/${id}/status`, { status: "solved" }],
      ["PATCH", `/api/artifacts/${id}/archived`, { archived: true }],
      ["PATCH", `/api/artifacts/${id}/organization`, { tagIds: [] }],
      ["PATCH", `/api/artifacts/${id}/visibility`, { visibility: "shared" }],
      ["POST", `/api/artifacts/${id}/comments`, { body: "hello" }],
      ["PUT", `/api/artifacts/${id}/entries`, { key: "vote", value: 1 }],
      ["DELETE", `/api/artifacts/${id}/entries?key=vote`],
    ];
    for (const [method, path, body] of attempts) {
      const res = await request(other, path, { method, body });
      const text = await res.text();
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(JSON.parse(text), `${method} ${path}`).toEqual({
        error: { code: "PRIVATE", message: "This artifact is private." },
      });
    }
  });

  test("refuses a new version uploaded to it", async () => {
    const res = await uploadForm(other, { title: "Mine now", artifactId: id });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "PRIVATE" } });
  });

  test("changes nothing when a non-creator tries to write to it", async () => {
    await request(other, `/api/artifacts/${id}/status`, {
      method: "PATCH",
      body: { status: "solved" },
    });
    await request(other, `/api/artifacts/${id}/comments`, {
      method: "POST",
      body: { body: "hello" },
    });
    const artifact = await request(owner, `/api/artifacts/${id}`);
    expect(await artifact.json()).toMatchObject({ artifact: { status: "open" } });
    const comments = await request(owner, `/api/artifacts/${id}/comments`);
    expect(await comments.json()).toEqual({ comments: [] });
  });

  test("still answers NOT_FOUND for an id that does not exist", async () => {
    const res = await request(other, "/api/artifacts/does-not-exist");
    expect(res.status).toBe(404);
  });

  test("stays readable and writable for its creator", async () => {
    expect((await request(owner, `/api/artifacts/${id}`)).status).toBe(200);
    const comment = await request(owner, `/api/artifacts/${id}/comments`, {
      method: "POST",
      body: { body: "note to self" },
    });
    expect(comment.status).toBe(201);
  });

  test("is left out of the listing, however it is searched for", async () => {
    await upload("Team roadmap");
    expect(await listedTitles(other)).toEqual(["Team roadmap"]);
    expect(await listedTitles(owner)).toEqual(["Team roadmap", "Salary review"]);
    const searched = await request(other, "/api/artifacts?q=Salary&archived=true");
    expect(await searched.json()).toMatchObject({ items: [] });
  });

  // TITLE_EXISTS names the existing artifact's id, which would tell the uploader
  // that the private artifact exists and what it is called.
  test("does not block another person from using the same title", async () => {
    const res = await uploadForm(other, { title: "Salary review" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { artifact: { id: string }; newArtifact: boolean };
    expect(body.newArtifact).toBe(true);
    expect(body.artifact.id).not.toBe(id);
  });

  test("is left out of the activity feed", async () => {
    await request(owner, `/api/artifacts/${id}/status`, {
      method: "PATCH",
      body: { status: "solved" },
    });
    const res = await request(other, "/api/activity");
    expect(await res.json()).toMatchObject({ items: [] });
  });

  test("is left out of folder and tag counts", async () => {
    const folder = await request(owner, "/api/folders", { method: "POST", body: { name: "HR" } });
    const tag = await request(owner, "/api/tags", { method: "POST", body: { name: "people" } });
    const folderId = ((await folder.json()) as { folder: { id: string } }).folder.id;
    const tagId = ((await tag.json()) as { tag: { id: string } }).tag.id;
    const filed = await request(owner, `/api/artifacts/${id}/organization`, {
      method: "PATCH",
      body: { folderId, tagIds: [tagId] },
    });
    expect(filed.status).toBe(200);

    const counts = async (cookie: string) => {
      const folders = (await (await request(cookie, "/api/folders")).json()) as {
        folders: { artifactCount: number }[];
      };
      const tags = (await (await request(cookie, "/api/tags")).json()) as {
        tags: { artifactCount: number }[];
      };
      return [folders.folders[0]?.artifactCount, tags.tags[0]?.artifactCount];
    };
    expect(await counts(owner)).toEqual([1, 1]);
    expect(await counts(other)).toEqual([0, 0]);
  });
});

describe("previews", () => {
  async function previewUrl(cookie: string, id: string): Promise<string> {
    const res = await request(cookie, `/api/artifacts/${id}/preview`, { method: "POST" });
    expect(res.status).toBe(200);
    return ((await res.json()) as { url: string }).url;
  }

  test("a preview URL issued while shared stops working once the artifact is private", async () => {
    const id = await upload("Plan");
    const theirs = await previewUrl(other, id);
    const mine = await previewUrl(owner, id);
    expect(theirs.startsWith(`${TEST_CONTENT_ORIGIN}/preview/`)).toBe(true);

    await setVisibility(owner, id, "private");

    expect((await server.app.request(theirs)).status).toBe(404);
    expect((await server.app.request(mine)).status).toBe(200);
  });
});

describe("a deployment without private artifacts", () => {
  let closed: TestServer;
  let cookie: string;

  beforeEach(async () => {
    closed = await createTestServer({ privateArtifacts: false });
    cookie = await closed.signIn();
  });

  afterEach(() => {
    closed.cleanup();
  });

  function closedRequest(path: string, init: { method?: string; body?: unknown } = {}) {
    return closed.app.request(path, {
      method: init.method ?? "GET",
      headers: { cookie, origin: TEST_BASE_URL, "content-type": "application/json" },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  }

  test("tells the client, so it does not offer privacy", async () => {
    const res = await closedRequest("/api/me");
    await expect(res.json()).resolves.toMatchObject({ features: { privateArtifacts: false } });
  });

  function closedUpload(fields: Record<string, string>) {
    const form = new FormData();
    form.set("file", htmlFile("<p>x</p>"));
    for (const [name, value] of Object.entries(fields)) form.set(name, value);
    return closed.app.request("/api/artifacts", {
      method: "POST",
      headers: { cookie, origin: TEST_BASE_URL },
      body: form,
    });
  }

  test("refuses a private upload and creates nothing", async () => {
    const res = await closedUpload({ title: "Secret", visibility: "private" });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "FORBIDDEN" } });

    const list = (await (await closedRequest("/api/artifacts")).json()) as { items: unknown[] };
    expect(list.items).toEqual([]);
  });

  test("refuses to make an artifact private, and it stays shared", async () => {
    const created = (await (await closedUpload({ title: "Plan" })).json()) as {
      artifact: { id: string };
    };
    const path = `/api/artifacts/${created.artifact.id}`;
    const res = await closedRequest(`${path}/visibility`, {
      method: "PATCH",
      body: { visibility: "private" },
    });
    expect(res.status).toBe(403);
    await expect((await closedRequest(path)).json()).resolves.toMatchObject({
      artifact: { visibility: "shared" },
    });
  });
});

describe("turning private artifacts off", () => {
  // The server would otherwise start with artifacts that nobody but their
  // creator can see and that nobody can share again from the client.
  function startWithout() {
    return createArtifactService({
      store: createArtifactStore({ database: server.database, dataDir: server.dataDir }),
      markdownStore: createMarkdownStore({ database: server.database }),
      commentStore: createCommentStore({ database: server.database }),
      entryStore: createEntryStore({ database: server.database }),
      privateArtifacts: false,
    });
  }

  test("refuses to start while private artifacts exist", async () => {
    const id = await upload("Plan", { visibility: "private" });
    expect(startWithout).toThrow(/1 private artifact/);

    await setVisibility(owner, id, "shared");
    expect(startWithout).not.toThrow();
  });
});
