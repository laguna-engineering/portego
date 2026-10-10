import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TEST_BASE_URL } from "../auth/testing.ts";
import { createSearchStore } from "../storage/search.ts";
import { createTestServer, type TestServer, WORKSPACE_USER } from "../testing.ts";
import type { TextSegment } from "./highlight.ts";
import type { SearchResults } from "./service.ts";

let server: TestServer;
let owner: string;
let ownerId: string;
let otherId: string;

beforeEach(async () => {
  server = await createTestServer();
  owner = await server.signIn();
  await server.signIn({
    ...WORKSPACE_USER,
    sub: "google-subject-2",
    email: "other@acme.example",
    name: "B Person",
  });
  const users = server.database.query('select id, email from "user"').all() as {
    id: string;
    email: string;
  }[];
  ownerId = users.find((user) => user.email !== "other@acme.example")?.id ?? "";
  otherId = users.find((user) => user.email === "other@acme.example")?.id ?? "";
});

afterEach(() => {
  server.cleanup();
});

function page(title: string, body: string): Uint8Array {
  return new TextEncoder().encode(
    `<!doctype html><html><head><title>${title}</title><style>.head { color: red }</style></head><body>${body}</body></html>`,
  );
}

async function upload(
  title: string,
  body: string,
  extra: { createdBy?: string; artifactId?: string; visibility?: "private" } = {},
) {
  const { artifact } = await server.artifacts.upload({
    bytes: page(title, body),
    title,
    createdBy: extra.createdBy ?? ownerId,
    ...(extra.artifactId ? { artifactId: extra.artifactId } : {}),
    ...(extra.visibility ? { visibility: extra.visibility } : {}),
  });
  return artifact.id;
}

function search(query: string, viewer = ownerId, scope: { artifactId?: string } = {}) {
  return server.artifacts.search({ userId: viewer }, { query, ...scope });
}

function contentTitles(results: SearchResults) {
  return results.content.map((hit) => hit.artifact.title);
}

function marked(segments: TextSegment[]) {
  return segments.filter((segment) => segment.match).map((segment) => segment.text);
}

describe("searching artifact text", () => {
  test("matches what a reader sees, not the HTML around it", async () => {
    await upload("Runbook", "<p>Start the rollback from the release dashboard.</p>");
    // Every page has <head> and <style>; neither may make it match.
    expect(contentTitles(search("head"))).toEqual([]);
    expect(contentTitles(search("color"))).toEqual([]);
    expect(contentTitles(search("dashboard"))).toEqual(["Runbook"]);
  });

  test("ignores link targets, so a URL does not match every page that links to it", async () => {
    await upload("Notes", '<p>See <a href="https://example.com/rollback">the guide</a>.</p>');
    expect(contentTitles(search("rollback"))).toEqual([]);
    expect(contentTitles(search("guide"))).toEqual(["Notes"]);
  });

  test("finds a word while it is being typed and other forms of a finished one", async () => {
    await upload("Plan", "<p>Running the rollbacks tonight.</p>");
    // "runn" is not a prefix of the stem "run", so only the plain index finds it.
    expect(contentTitles(search("runn"))).toEqual(["Plan"]);
    expect(contentTitles(search("rollback"))).toEqual(["Plan"]);
    expect(contentTitles(search("run tonig"))).toEqual(["Plan"]);
    expect(contentTitles(search("run tomorrow"))).toEqual([]);
  });

  test("matches a query that mixes another form of one word with the start of another", async () => {
    await upload("Plan", "<p>She tried it tonight.</p>");
    // Only the porter index has "tries", and only the prefix index has "tonig".
    const [hit] = search("tries tonig").content;
    expect(hit?.artifact.title).toBe("Plan");
    expect(marked(hit?.snippet ?? [])).toEqual(["tried", "tonight"]);
  });

  test("marks another form of the word, so the snippet shows why the artifact matched", async () => {
    await upload("Notes", `<p>${"filler ".repeat(60)}She tried it twice.</p>`);
    const [hit] = search("tries").content;
    expect(marked(hit?.snippet ?? [])).toEqual(["tried"]);
    expect(hit?.snippet[0]?.text).toBe("…");
  });

  test("matches forms of the same word only, not every word that starts with its stem", async () => {
    await upload("Travel", "<p>The trip and the tribe.</p>");
    expect(contentTitles(search("tries"))).toEqual([]);
    expect(contentTitles(search("tri"))).toEqual(["Travel"]);
  });

  test("shows the match in context and counts it", async () => {
    await upload("Plan", `<p>${"filler ".repeat(60)}Start the Rollback. Then rollback again.</p>`);
    const [hit] = search("rollback").content;
    expect(hit?.matches).toBe(2);
    expect(marked(hit?.snippet ?? [])).toEqual(["Rollback", "rollback"]);
    expect(hit?.snippet[0]?.text).toBe("…");
  });

  test("starts a snippet at a block boundary, not inside the word before it", async () => {
    await upload("Plan", `<p>${"x".repeat(100)}</p><p>rollback</p>`);
    const [hit] = search("rollback").content;
    expect(hit?.snippet.map((segment) => segment.text).join("")).toBe("…rollback");
  });

  test("searches only the current version", async () => {
    const id = await upload("Plan", "<p>The rollback is manual.</p>");
    await upload("Plan", "<p>The deploy is automatic.</p>", { artifactId: id });
    expect(contentTitles(search("rollback"))).toEqual([]);
    expect(contentTitles(search("automatic"))).toEqual(["Plan"]);
  });

  test("indexes uploaded Markdown as text", async () => {
    await server.artifacts.upload({
      bytes: new TextEncoder().encode(
        "# Launch\n\nCheck the **rollback** [link](https://x.example/head).",
      ),
      contentType: "markdown",
      createdBy: ownerId,
    });
    expect(contentTitles(search("rollback"))).toEqual(["Launch"]);
    expect(contentTitles(search("head"))).toEqual([]);
  });

  test("indexes versions uploaded before search existed", async () => {
    await upload("Plan", "<p>The rollback is manual.</p>");
    server.database.exec("delete from searchDocuments where kind = 'version'");
    expect(contentTitles(search("rollback"))).toEqual([]);

    expect(await server.artifacts.reindexVersions()).toEqual({ indexed: 1, failed: [] });
    expect(contentTitles(search("rollback"))).toEqual(["Plan"]);
    expect((await server.artifacts.reindexVersions()).indexed).toBe(0);
  });

  test("reindexes text that older code produced, so a fix to the text reaches old versions", async () => {
    await upload("Plan", "<p>The rollback is manual.</p>");
    server.database.exec(
      "update searchDocuments set body = 'stale', textVersion = '0.0' where kind = 'version'",
    );
    expect(contentTitles(search("rollback"))).toEqual([]);

    expect((await server.artifacts.reindexVersions()).indexed).toBe(1);
    expect(contentTitles(search("rollback"))).toEqual(["Plan"]);
  });

  test("does not index a version that no longer exists", () => {
    createSearchStore({ database: server.database }).indexVersion("gone", "rollback", "1.1");
    const { count } = server.database
      .query("select count(*) as count from searchDocuments where refId = 'gone'")
      .get() as { count: number };
    expect(count).toBe(0);
  });
});

describe("searching titles and comments", () => {
  test("marks the matched words of a title", async () => {
    await upload("Lampo rollback runbook", "<p>x</p>");
    const [hit] = search("rollb").artifacts;
    expect(marked(hit?.title ?? [])).toEqual(["rollback"]);
    expect(hit?.snippet).toBeNull();
  });

  test("finds a comment until it is deleted", async () => {
    const id = await upload("Plan", "<p>x</p>");
    const comment = server.artifacts.addComment(id, {
      authorId: ownerId,
      body: "Do we have a rollback path?",
    });
    const [hit] = search("rollback").comments;
    expect(hit?.artifact.id).toBe(id);
    expect(hit?.comment.id).toBe(comment.id);

    server.artifacts.deleteComment(id, comment.id, ownerId);
    expect(search("rollback").comments).toEqual([]);
  });
});

describe("what search can see", () => {
  test("leaves out other people's private artifacts, their text, and their comments", async () => {
    const id = await upload("Secret rollback", "<p>The rollback plan.</p>", {
      visibility: "private",
    });
    server.artifacts.addComment(id, { authorId: ownerId, body: "rollback soon" });

    const mine = search("rollback");
    expect([mine.artifacts, mine.content, mine.comments].map((group) => group.length)).toEqual([
      1, 1, 1,
    ]);
    const theirs = search("rollback", otherId);
    expect(theirs.total).toBe(0);
    expect([theirs.artifacts, theirs.content, theirs.comments]).toEqual([[], [], []]);
  });

  test("leaves out archived artifacts unless they are asked for", async () => {
    const id = await upload("Plan", "<p>rollback</p>");
    server.artifacts.setArchived(id, true, ownerId);
    expect(search("rollback").total).toBe(0);
    expect(
      server.artifacts.search({ userId: ownerId }, { query: "rollback", includeArchived: true })
        .total,
    ).toBe(1);
  });

  test("limits to one artifact", async () => {
    const id = await upload("Plan", "<p>rollback</p>");
    await upload("Other", "<p>rollback</p>");
    expect(contentTitles(search("rollback", ownerId, { artifactId: id }))).toEqual(["Plan"]);
  });
});

describe("searching tags and folders", () => {
  test("finds a name by every word, wherever they are in it", () => {
    server.organization.createTag({ name: "release-rollback", actorId: ownerId });
    server.organization.createTag({ name: "release notes", actorId: ownerId });
    const names = (query: string) => search(query).tags.map((tag) => tag.name);
    expect(names("rollback release")).toEqual(["release-rollback"]);
    expect(names("release").sort()).toEqual(["release notes", "release-rollback"]);
  });

  test("finds a folder that holds nothing yet, counted as empty", () => {
    server.organization.createFolder({ name: "Runbooks", actorId: ownerId });
    expect(search("runbook").folders.map(({ name, count }) => ({ name, count }))).toEqual([
      { name: "Runbooks", count: 0 },
    ]);
  });

  test("counts only the artifacts the viewer can see", async () => {
    const folder = server.organization.createFolder({ name: "Runbooks", actorId: ownerId });
    const id = await upload("Secret", "<p>x</p>", { visibility: "private" });
    server.organization.setArtifactOrganization(id, { folderId: folder.id, actorId: ownerId });
    expect(search("runbooks").folders[0]?.count).toBe(1);
    expect(search("runbooks", otherId).folders[0]?.count).toBe(0);
  });
});

describe("the search total", () => {
  test("counts each matching artifact once, as many as the gallery filter lists", async () => {
    const id = await upload("Rollback plan", "<p>The rollback is manual.</p>");
    server.artifacts.addComment(id, { authorId: ownerId, body: "rollback soon" });
    server.artifacts.addComment(id, { authorId: ownerId, body: "rollback tested" });
    await upload("Other", "<p>rollback</p>");
    expect(search("rollback").total).toBe(2);
  });
});

describe("the gallery filter", () => {
  test("matches artifact text and comments as well as titles", async () => {
    await upload("By text", "<p>The rollback plan.</p>");
    const commented = await upload("By comment", "<p>x</p>");
    server.artifacts.addComment(commented, { authorId: ownerId, body: "rollback?" });
    await upload("Unrelated", "<p>x</p>");

    const res = await server.app.request("/api/artifacts?q=rollback", {
      headers: { cookie: owner, origin: TEST_BASE_URL },
    });
    const { items } = (await res.json()) as { items: { title: string }[] };
    expect(items.map((item) => item.title).sort()).toEqual(["By comment", "By text"]);
  });

  test("the search route returns grouped results", async () => {
    await upload("Plan", "<p>rollback</p>");
    const res = await server.app.request("/api/artifacts/search?q=rollback", {
      headers: { cookie: owner, origin: TEST_BASE_URL },
    });
    expect(res.status).toBe(200);
    const results = (await res.json()) as SearchResults;
    expect(contentTitles(results)).toEqual(["Plan"]);
  });
});
