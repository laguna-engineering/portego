import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TEST_BASE_URL } from "../auth/testing.ts";
import { pngBytes } from "../storage/testing.ts";
import { createTestServer, htmlFile, type TestServer } from "../testing.ts";
import { mintUploadTicket, UPLOAD_TICKET_TTL_SECONDS } from "./tickets.ts";

let server: TestServer;
let cookie: string;

beforeEach(async () => {
  server = await createTestServer();
  cookie = await server.signIn();
});

afterEach(() => {
  server.cleanup();
});

function upload(
  fields: {
    file?: File;
    title?: string;
    description?: string;
    contentType?: "html" | "markdown";
    markdown?: string;
  } = {},
) {
  const form = new FormData();
  form.set("file", fields.file ?? htmlFile("<h1>A chart</h1>", "chart.html"));
  if (fields.contentType !== undefined) form.set("contentType", fields.contentType);
  if (fields.markdown !== undefined) form.set("markdown", fields.markdown);
  if (fields.title !== undefined) form.set("title", fields.title);
  if (fields.description !== undefined) form.set("description", fields.description);
  return server.app.request("/api/artifacts", {
    method: "POST",
    headers: { cookie, origin: TEST_BASE_URL },
    body: form,
  });
}

async function uploadedId(title = "A chart"): Promise<string> {
  const res = await upload({ title });
  const body = (await res.json()) as { artifact: { id: string } };
  return body.artifact.id;
}

describe("authorization", () => {
  test("refuses every artifact route without a session", async () => {
    for (const path of [
      "/api/artifacts",
      "/api/artifacts/any-id",
      "/api/artifacts/any-id/source",
    ]) {
      const res = await server.app.request(path);
      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toMatchObject({ error: { code: "UNAUTHENTICATED" } });
    }
  });

  test("answers the same way for an artifact that exists and one that does not", async () => {
    const id = await uploadedId();
    const existing = await server.app.request(`/api/artifacts/${id}`);
    const missing = await server.app.request("/api/artifacts/does-not-exist");

    expect(existing.status).toBe(401);
    expect(await existing.text()).toBe(await missing.text());
  });

  test("refuses an anonymous upload", async () => {
    const form = new FormData();
    form.set("file", htmlFile("<p>x</p>"));
    const res = await server.app.request("/api/artifacts", {
      method: "POST",
      headers: { origin: TEST_BASE_URL },
      body: form,
    });
    expect(res.status).toBe(401);
  });
});

describe("upload", () => {
  test("stores the document and reports its metadata", async () => {
    const res = await upload({ title: "Sales chart", description: "Q3 by region" });
    expect(res.status).toBe(201);

    const body = (await res.json()) as { artifact: Record<string, unknown> };
    expect(body.artifact).toMatchObject({
      title: "Sales chart",
      description: "Q3 by region",
      originalFilename: "chart.html",
      creator: { name: "A Person", email: "person@acme.example" },
    });
    expect(body.artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("records the signed-in user as the creator, ignoring any claim in the form", async () => {
    const form = new FormData();
    form.set("file", htmlFile("<p>x</p>"));
    form.set("title", "A chart");
    form.set("createdBy", "someone-else");
    const res = await server.app.request("/api/artifacts", {
      method: "POST",
      headers: { cookie, origin: TEST_BASE_URL },
      body: form,
    });

    const body = (await res.json()) as { artifact: { creator: { id: string } } };
    const session = await server.auth.api.getSession({ headers: new Headers({ cookie }) });
    expect(body.artifact.creator.id).toBe(session?.user.id ?? "");
    expect(body.artifact.creator.id).not.toBe("someone-else");
  });

  test("takes the title from the document when the form leaves it out", async () => {
    const res = await upload({});
    const body = (await res.json()) as { artifact: { title: string } };
    expect(body.artifact.title).toBe("Doc");
  });

  test("keeps the Markdown sent with an HTML upload as what agents read back", async () => {
    const res = await upload({
      file: htmlFile("<h1>A chart</h1><svg><text>42%</text></svg>", "chart.html"),
      markdown: "# A chart\n\nConversion is 42%.",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { artifact: { id: string } };

    const markdown = await server.app.request(`/api/artifacts/${body.artifact.id}/markdown`, {
      headers: { cookie },
    });
    await expect(markdown.json()).resolves.toMatchObject({
      markdown: "# A chart\n\nConversion is 42%.",
      source: "provided",
    });
  });

  test("refuses companion Markdown on a Markdown upload, which is its own text", async () => {
    const res = await upload({
      file: new File(["# Report"], "report.md"),
      contentType: "markdown",
      markdown: "# Report",
    });
    expect(res.status).toBe(400);
  });

  test("renders Markdown to static HTML and returns the supplied Markdown", async () => {
    const res = await upload({
      file: new File(
        ["# Weekly report\n\n<script>run()</script>\n\n[Source](https://example.com)"],
        "weekly.md",
      ),
      contentType: "markdown",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { artifact: { id: string; originalFilename: string } };
    expect(body.artifact.originalFilename).toBe("weekly.html");

    const source = await server.app.request(`/api/artifacts/${body.artifact.id}/source`, {
      headers: { cookie },
    });
    const html = await source.text();
    expect(html).toContain("<h1>Weekly report</h1>");
    expect(html).toContain("&lt;script&gt;run()&lt;/script&gt;");

    const markdown = await server.app.request(`/api/artifacts/${body.artifact.id}/markdown`, {
      headers: { cookie },
    });
    await expect(markdown.json()).resolves.toMatchObject({
      markdown: "# Weekly report\n\n<script>run()</script>\n\n[Source](https://example.com)",
      source: "provided",
      converterVersion: "provided",
    });
  });

  test("refuses a document with no title anywhere, rather than inventing one", async () => {
    const file = new File(["<!doctype html><p>no title</p>"], "x.html", { type: "text/html" });
    const res = await upload({ file });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "TITLE_REQUIRED" } });
  });

  test("refuses an empty file", async () => {
    const res = await upload({ file: new File([], "empty.html", { type: "text/html" }) });
    expect(res.status).toBe(400);
  });

  test("refuses a file that is not HTML, whatever it calls itself", async () => {
    const file = new File(["id,name\n1,a\n"], "report.html", { type: "text/html" });
    const res = await upload({ file });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "UNSUPPORTED_CONTENT" } });
  });

  test("refuses bytes that are not valid UTF-8", async () => {
    const file = new File([new Uint8Array([0xff, 0xfe, 0x00, 0x3c])], "x.html");
    const res = await upload({ file });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "UNSUPPORTED_CONTENT" } });
  });

  test("refuses a file over the configured limit", async () => {
    const small = await createTestServer({ maxUploadBytes: 2048 });
    try {
      const smallCookie = await small.signIn();
      const form = new FormData();
      form.set("file", htmlFile("x".repeat(4096)));
      form.set("title", "Too big");
      const res = await small.app.request("/api/artifacts", {
        method: "POST",
        headers: { cookie: smallCookie, origin: TEST_BASE_URL },
        body: form,
      });
      expect(res.status).toBe(413);
      await expect(res.json()).resolves.toMatchObject({ error: { code: "FILE_TOO_LARGE" } });
    } finally {
      small.cleanup();
    }
  });

  test("keeps a path-like upload name from becoming a path", async () => {
    const file = htmlFile("<p>x</p>", "../../../etc/passwd.html");
    const res = await upload({ file, title: "Odd name" });
    const body = (await res.json()) as { artifact: { originalFilename: string } };
    expect(body.artifact.originalFilename).toBe("passwd.html");
  });

  test("refuses a request that carries no file", async () => {
    const form = new FormData();
    form.set("title", "No file");
    const res = await server.app.request("/api/artifacts", {
      method: "POST",
      headers: { cookie, origin: TEST_BASE_URL },
      body: form,
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "INVALID_INPUT" } });
  });

  test("never reports where the bytes are stored", async () => {
    const res = await upload({ title: "A chart" });
    expect(await res.text()).not.toContain("storageKey");
  });
});

describe("list", () => {
  test("returns the newest first and pages with a cursor", async () => {
    await uploadedId("First");
    await uploadedId("Second");
    await uploadedId("Third");

    const first = await server.app.request("/api/artifacts?limit=2", { headers: { cookie } });
    const firstPage = (await first.json()) as {
      items: { title: string }[];
      nextCursor: string | null;
    };
    expect(firstPage.items.map((item) => item.title)).toEqual(["Third", "Second"]);
    expect(firstPage.nextCursor).not.toBeNull();

    const second = await server.app.request(
      `/api/artifacts?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor ?? "")}`,
      { headers: { cookie } },
    );
    const secondPage = (await second.json()) as {
      items: { title: string }[];
      nextCursor: string | null;
    };
    expect(secondPage.items.map((item) => item.title)).toEqual(["First"]);
    expect(secondPage.nextCursor).toBeNull();
  });

  test("orders by title when asked and refuses an order it does not define", async () => {
    await uploadedId("Beta");
    await uploadedId("alpha");

    const ordered = await server.app.request("/api/artifacts?sort=title-asc", {
      headers: { cookie },
    });
    const page = (await ordered.json()) as { items: { title: string }[] };
    expect(page.items.map((item) => item.title)).toEqual(["alpha", "Beta"]);

    const refused = await server.app.request("/api/artifacts?sort=size", { headers: { cookie } });
    expect(refused.status).toBe(400);
  });

  test("filters by a search term", async () => {
    await uploadedId("Sales chart");
    await uploadedId("Latency report");

    const res = await server.app.request("/api/artifacts?q=latency", { headers: { cookie } });
    const body = (await res.json()) as { items: { title: string }[] };
    expect(body.items.map((item) => item.title)).toEqual(["Latency report"]);
  });

  test("refuses a cursor it did not produce", async () => {
    const res = await server.app.request("/api/artifacts?cursor=nonsense", { headers: { cookie } });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "INVALID_CURSOR" } });
  });

  test("refuses a limit that is not a number", async () => {
    const res = await server.app.request("/api/artifacts?limit=many", { headers: { cookie } });
    expect(res.status).toBe(400);
  });
});

describe("metadata", () => {
  test("returns one artifact", async () => {
    const id = await uploadedId("Sales chart");
    const res = await server.app.request(`/api/artifacts/${id}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ artifact: { id, title: "Sales chart" } });
  });

  test("reports an unknown id as not found", async () => {
    const res = await server.app.request("/api/artifacts/missing", { headers: { cookie } });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "NOT_FOUND" } });
  });
});

describe("markdown", () => {
  test("returns the static content of an artifact as Markdown", async () => {
    const file = new File(
      ["<!doctype html><html><title>Doc</title><h1>Heading</h1><p>text</p></html>"],
      "doc.html",
      { type: "text/html" },
    );
    const created = (await (await upload({ file, title: "Doc" })).json()) as {
      artifact: { id: string };
    };

    const res = await server.app.request(`/api/artifacts/${created.artifact.id}/markdown`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      markdown: "# Heading\n\ntext",
      empty: false,
      converterVersion: "1",
    });
  });

  test("needs the same session the source needs", async () => {
    const id = await uploadedId();
    expect((await server.app.request(`/api/artifacts/${id}/markdown`)).status).toBe(401);
  });

  test("reports an unknown id as not found", async () => {
    const res = await server.app.request("/api/artifacts/missing/markdown", {
      headers: { cookie },
    });
    expect(res.status).toBe(404);
  });

  test("converts once and serves the stored conversion afterwards", async () => {
    const id = await uploadedId();
    const first = (await (
      await server.app.request(`/api/artifacts/${id}/markdown`, { headers: { cookie } })
    ).json()) as { generatedAt: string };
    const second = (await (
      await server.app.request(`/api/artifacts/${id}/markdown`, { headers: { cookie } })
    ).json()) as { generatedAt: string };

    expect(second.generatedAt).toBe(first.generatedAt);
  });
});

describe("source download", () => {
  test("sends the bytes as an attachment the browser will not render", async () => {
    const id = await uploadedId("A chart");
    const res = await server.app.request(`/api/artifacts/${id}/source`, { headers: { cookie } });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("content-disposition")).toContain("chart.html");
    expect(await res.text()).toContain("<h1>A chart</h1>");
  });

  test("quotes a filename that would otherwise break the header", async () => {
    const file = htmlFile("<p>x</p>", 'we"ird;name.html');
    const created = (await (await upload({ file, title: "Odd" })).json()) as {
      artifact: { id: string };
    };
    const res = await server.app.request(`/api/artifacts/${created.artifact.id}/source`, {
      headers: { cookie },
    });

    const disposition = res.headers.get("content-disposition") ?? "";
    expect(disposition.match(/"/g)).toHaveLength(2);
    expect(disposition).toContain("filename*=UTF-8''");
  });

  test("reports an unknown id as not found", async () => {
    const res = await server.app.request("/api/artifacts/missing/source", { headers: { cookie } });
    expect(res.status).toBe(404);
  });
});

describe("upload by ticket", () => {
  async function ticketFor(sessionCookie: string): Promise<string> {
    const session = await server.auth.api.getSession({
      headers: new Headers({ cookie: sessionCookie }),
    });
    return mintUploadTicket(server.signingSecret, session?.user.id ?? "").ticket;
  }

  function send(ticket: string, fields: { file?: File; title?: string } = {}) {
    const form = new FormData();
    form.set("file", fields.file ?? htmlFile("<h1>From a file</h1>", "page.html"));
    if (fields.title !== undefined) form.set("title", fields.title);
    return server.app.request("/api/uploads", {
      method: "POST",
      headers: { authorization: `Bearer ${ticket}` },
      body: form,
    });
  }

  test("stores the document without a session, crediting the ticket's user", async () => {
    const res = await send(await ticketFor(cookie), { title: "From the Pi" });
    expect(res.status).toBe(201);

    const body = (await res.json()) as { artifact: Record<string, unknown> };
    expect(body.artifact).toMatchObject({
      title: "From the Pi",
      originalFilename: "page.html",
      creator: { name: "A Person", email: "person@acme.example" },
    });
  });

  test("refuses a request carrying no ticket", async () => {
    const form = new FormData();
    form.set("file", htmlFile("<p>x</p>"));
    const res = await server.app.request("/api/uploads", { method: "POST", body: form });
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "UNAUTHENTICATED" } });
  });

  // A session cookie is not an upload ticket. If it were accepted here, this
  // route would be a second way to upload that skips the same-origin check.
  test("refuses a session cookie in place of a ticket", async () => {
    const form = new FormData();
    form.set("file", htmlFile("<p>x</p>"));
    const res = await server.app.request("/api/uploads", {
      method: "POST",
      headers: { cookie, origin: TEST_BASE_URL },
      body: form,
    });
    expect(res.status).toBe(401);
  });

  test("refuses a ticket after it expires", async () => {
    const session = await server.auth.api.getSession({ headers: new Headers({ cookie }) });
    const past = new Date(Date.now() - (UPLOAD_TICKET_TTL_SECONDS + 60) * 1000);
    const { ticket } = mintUploadTicket(server.signingSecret, session?.user.id ?? "", past);

    const res = await send(ticket);
    expect(res.status).toBe(401);
  });

  test("refuses a ticket whose user id was swapped for another", async () => {
    const [version, , expiry, signature] = (await ticketFor(cookie)).split(".");
    const otherId = Buffer.from("someone-else", "utf8").toString("base64url");

    const res = await send([version, otherId, expiry, signature].join("."));
    expect(res.status).toBe(401);
  });

  test("applies the same content rules as the session upload", async () => {
    const res = await send(await ticketFor(cookie), {
      file: new File(["plain notes, no markup"], "notes.txt"),
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "UNSUPPORTED_CONTENT" } });
  });
});

describe("versions", () => {
  async function uploadVersion(fields: {
    title?: string;
    artifactId?: string;
    html?: string;
    allowDuplicateTitle?: boolean;
    folderId?: string;
    tagIds?: string[];
  }) {
    const form = new FormData();
    form.set("file", htmlFile(fields.html ?? "<h1>Revised</h1>", "revised.html"));
    if (fields.title !== undefined) form.set("title", fields.title);
    if (fields.artifactId !== undefined) form.set("artifactId", fields.artifactId);
    if (fields.allowDuplicateTitle) form.set("allowDuplicateTitle", "true");
    if (fields.folderId !== undefined) form.set("folderId", fields.folderId);
    for (const tagId of fields.tagIds ?? []) form.append("tagId", tagId);
    const res = await server.app.request("/api/artifacts", {
      method: "POST",
      headers: { cookie, origin: TEST_BASE_URL },
      body: form,
    });
    return {
      status: res.status,
      body: (await res.json()) as {
        artifact: {
          id: string;
          versionCount: number;
          currentVersionId: string;
          sha256: string;
          folder: { id: string } | null;
          tags: { id: string }[];
        };
        newArtifact: boolean;
        error?: { code: string; artifactId?: string };
      },
    };
  }

  async function created(path: "folders" | "tags", name: string): Promise<string> {
    const res = await server.app.request(`/api/${path}`, {
      method: "POST",
      headers: { cookie, origin: TEST_BASE_URL, "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const body = (await res.json()) as { folder?: { id: string }; tag?: { id: string } };
    return (body.folder ?? body.tag)?.id ?? "";
  }

  async function artifactCount(): Promise<number> {
    const list = await server.app.request("/api/artifacts", { headers: { cookie } });
    return ((await list.json()) as { items: unknown[] }).items.length;
  }

  async function versionsOf(id: string) {
    const res = await server.app.request(`/api/artifacts/${id}/versions`, { headers: { cookie } });
    return ((await res.json()) as { versions: { id: string; number: number }[] }).versions;
  }

  // A shared link must never start showing someone else's document because
  // two uploads happened to share a title.
  test("refuses an existing title without artifactId instead of adding a version", async () => {
    const id = await uploadedId("Quarterly report");
    const again = await uploadVersion({ title: "Quarterly report" });

    expect(again.status).toBe(409);
    expect(again.body.error).toEqual(
      expect.objectContaining({ code: "TITLE_EXISTS", artifactId: id }),
    );
    expect(await artifactCount()).toBe(1);
    expect((await versionsOf(id)).map((version) => version.number)).toEqual([1]);
  });

  test("creates a separate artifact with an existing title when asked to", async () => {
    const id = await uploadedId("Quarterly report");
    const again = await uploadVersion({ title: "Quarterly report", allowDuplicateTitle: true });

    expect(again.status).toBe(201);
    expect(again.body.newArtifact).toBe(true);
    expect(again.body.artifact.id).not.toBe(id);
    expect(await artifactCount()).toBe(2);
    expect((await versionsOf(id)).map((version) => version.number)).toEqual([1]);
  });

  test("files a new artifact in the folder and tags the upload names", async () => {
    const folderId = await created("folders", "Reports");
    const tagId = await created("tags", "finance");
    const result = await uploadVersion({ title: "Filed", folderId, tagIds: [tagId] });

    expect(result.status).toBe(201);
    expect(result.body.artifact.folder?.id).toBe(folderId);
    expect(result.body.artifact.tags.map((tag) => tag.id)).toEqual([tagId]);
  });

  test("refuses an unknown folder before storing anything", async () => {
    const result = await uploadVersion({ title: "Lost", folderId: "no-such-folder" });
    expect(result.status).toBe(404);
    expect(await artifactCount()).toBe(0);
  });

  test("a new version keeps the folder unless the upload names another", async () => {
    const reports = await created("folders", "Reports");
    const archive = await created("folders", "Archive");
    const first = await uploadVersion({ title: "Moving", folderId: reports });
    const id = first.body.artifact.id;

    const kept = await uploadVersion({ artifactId: id });
    expect(kept.body.artifact.folder?.id).toBe(reports);

    const moved = await uploadVersion({ artifactId: id, folderId: archive });
    expect(moved.body.artifact.folder?.id).toBe(archive);
    expect(moved.body.artifact.versionCount).toBe(3);
  });

  test("adds a version to the artifact named by artifactId whatever the title", async () => {
    const id = await uploadedId("Original name");
    const result = await uploadVersion({ title: "A different name", artifactId: id });
    expect(result.body.newArtifact).toBe(false);
    expect(result.body.artifact.id).toBe(id);

    const read = await server.app.request(`/api/artifacts/${id}`, { headers: { cookie } });
    expect(((await read.json()) as { artifact: { title: string } }).artifact.title).toBe(
      "Original name",
    );
  });

  test("refuses an artifactId that does not exist instead of creating an artifact", async () => {
    const result = await uploadVersion({ title: "Orphan", artifactId: "no-such-artifact" });
    expect(result.status).toBe(404);
    const list = await server.app.request("/api/artifacts", { headers: { cookie } });
    expect(((await list.json()) as { items: unknown[] }).items).toHaveLength(0);
  });

  test("serves any version's bytes and markdown, and the current one by default", async () => {
    const id = await uploadedId("Evolving");
    await uploadVersion({ artifactId: id, html: "<h1>Second</h1>" });
    const [, first] = await versionsOf(id);
    if (!first) throw new Error("expected version 1");

    const current = await server.app.request(`/api/artifacts/${id}/source`, {
      headers: { cookie },
    });
    expect(await current.text()).toContain("Second");
    expect(current.headers.get("content-disposition")).toContain("revised.html");

    const old = await server.app.request(`/api/artifacts/${id}/source?version=${first.id}`, {
      headers: { cookie },
    });
    expect(await old.text()).toContain("A chart");
    expect(old.headers.get("content-disposition")).toContain("chart.html");

    const markdown = await server.app.request(`/api/artifacts/${id}/markdown?version=${first.id}`, {
      headers: { cookie },
    });
    expect(((await markdown.json()) as { markdown: string }).markdown).toContain("A chart");
  });

  test("refuses a version that belongs to another artifact", async () => {
    const id = await uploadedId("One");
    const other = await uploadedId("Two");
    for (const path of ["source", "markdown"]) {
      const res = await server.app.request(`/api/artifacts/${id}/${path}?version=${other}`, {
        headers: { cookie },
      });
      expect(res.status).toBe(404);
    }
    const preview = await server.app.request(`/api/artifacts/${id}/preview?version=${other}`, {
      method: "POST",
      headers: { cookie, origin: TEST_BASE_URL },
    });
    expect(preview.status).toBe(404);
  });

  test("records the version a comment was written on, and a reply follows its thread", async () => {
    const id = await uploadedId("Discussed");
    await uploadVersion({ artifactId: id });
    const [latest, first] = await versionsOf(id);
    if (!latest || !first) throw new Error("expected two versions");

    const post = (body: Record<string, unknown>) =>
      server.app.request(`/api/artifacts/${id}/comments`, {
        method: "POST",
        headers: { cookie, origin: TEST_BASE_URL, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const onCurrent = (await (await post({ body: "now" })).json()) as {
      comment: { id: string; versionId: string; versionNumber: number };
    };
    const onFirst = (await (await post({ body: "then", versionId: first.id })).json()) as {
      comment: { id: string; versionId: string; versionNumber: number };
    };
    const reply = (await (
      await post({ body: "still then", parentId: onFirst.comment.id, versionId: latest.id })
    ).json()) as { comment: { versionId: string } };

    expect(onCurrent.comment.versionId).toBe(latest.id);
    expect(onCurrent.comment.versionNumber).toBe(2);
    expect(onFirst.comment.versionNumber).toBe(1);
    expect(reply.comment.versionId).toBe(first.id);

    const foreign = await post({ body: "nowhere", versionId: "not-a-version" });
    expect(foreign.status).toBe(404);
  });
});

describe("images", () => {
  function pngFile(name: string, seed = ""): File {
    return new File([pngBytes(seed)], name, { type: "image/png" });
  }

  function sendWithImages(images: (File | string)[], fields: { contentType?: string } = {}) {
    const form = new FormData();
    form.set(
      "file",
      htmlFile('<!doctype html><title>Chart</title><img src="images/chart.png">', "chart.html"),
    );
    if (fields.contentType !== undefined) form.set("contentType", fields.contentType);
    for (const image of images) form.append("image", image);
    return server.app.request("/api/artifacts", {
      method: "POST",
      headers: { cookie, origin: TEST_BASE_URL },
      body: form,
    });
  }

  async function previewOf(id: string): Promise<string> {
    const res = await server.app.request(`/api/artifacts/${id}/preview`, {
      method: "POST",
      headers: { cookie, origin: TEST_BASE_URL },
    });
    return ((await res.json()) as { url: string }).url;
  }

  test("stores each image with the version, under the name the HTML uses", async () => {
    const res = await sendWithImages([pngFile("chart.png", "a"), pngFile("logo.png", "b")]);
    expect(res.status).toBe(201);
    const { artifact } = (await res.json()) as { artifact: { id: string } };

    const url = await previewOf(artifact.id);
    const logo = await server.app.request(new URL("images/logo.png", url).href);
    expect(new Uint8Array(await logo.arrayBuffer())).toEqual(pngBytes("b"));
  });

  test("accepts images through an upload ticket, the path the local tool uses", async () => {
    const session = await server.auth.api.getSession({ headers: new Headers({ cookie }) });
    const { ticket } = mintUploadTicket(server.signingSecret, session?.user.id ?? "");
    const form = new FormData();
    form.set("file", htmlFile("<h1>From a file</h1>", "page.html"));
    form.append("image", pngFile("chart.png"));
    const res = await server.app.request("/api/uploads", {
      method: "POST",
      headers: { authorization: `Bearer ${ticket}` },
      body: form,
    });
    expect(res.status).toBe(201);
  });

  test("refuses an SVG image and stores nothing, since SVG can carry script", async () => {
    const svg = new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], "chart.svg");
    const res = await sendWithImages([pngFile("logo.png"), svg]);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "UNSUPPORTED_CONTENT" } });
    expect(server.artifacts.list().items).toEqual([]);
  });

  test("refuses images with a Markdown upload, whose rendering never loads them", async () => {
    const form = new FormData();
    form.set("file", new File(["# Chart"], "chart.md"));
    form.set("contentType", "markdown");
    form.append("image", pngFile("chart.png"));
    const res = await server.app.request("/api/artifacts", {
      method: "POST",
      headers: { cookie, origin: TEST_BASE_URL },
      body: form,
    });
    expect(res.status).toBe(400);
  });

  test("refuses an image field that is text instead of a file", async () => {
    const res = await sendWithImages(["not a file"]);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "INVALID_INPUT" } });
  });

  test("refuses an image whose name would need a path", async () => {
    const res = await sendWithImages([pngFile("../chart.png")]);
    expect(res.status).toBe(400);
  });
});
