import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLiveTestServer, type LiveTestServer, WORKSPACE_USER } from "../testing.ts";
import { authorizeClient, callTool, type McpClient, registerClient } from "./testing.ts";

let server: LiveTestServer;
let cookie: string;
let client: McpClient;

beforeAll(async () => {
  server = await createLiveTestServer();
  cookie = await server.signIn();
  client = await authorizeClient(server, {
    cookie,
    clientId: await registerClient(server, cookie),
  });
});

afterAll(() => {
  server.stop();
});

async function tools(): Promise<string[]> {
  const response = await client.call({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const body = (await response.json()) as { result: { tools: { name: string }[] } };
  return body.result.tools.map((tool) => tool.name);
}

async function upload(title = "From MCP", html = "<!doctype html><html><title>t</title>hi</html>") {
  const result = await callTool(client, "upload_artifact", { title, html });
  return result.result?.structuredContent as { id: string; url: string; sha256: string };
}

describe("discovery", () => {
  test("publishes protected resource metadata naming the exact MCP URL", async () => {
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const response = await fetch(`${server.origin}${path}`);
      expect(response.status, path).toBe(200);
      const body = (await response.json()) as {
        resource: string;
        authorization_servers: string[];
        scopes_supported: string[];
      };
      expect(body.resource).toBe(`${server.origin}/mcp`);
      expect(body.authorization_servers).toEqual([`${server.origin}/api/auth`]);
      expect(body.scopes_supported).toEqual(["artifacts:read", "artifacts:write"]);
    }
  });

  test("publishes authorization server metadata where a client looks for it", async () => {
    const response = await fetch(
      `${server.origin}/.well-known/oauth-authorization-server/api/auth`,
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      issuer: string;
      code_challenge_methods_supported: string[];
      client_id_metadata_document_supported: boolean;
    };
    expect(body.issuer).toBe(`${server.origin}/api/auth`);
    expect(body.code_challenge_methods_supported).toContain("S256");
    // Client ID Metadata Documents are how an MCP client registers here.
    expect(body.client_id_metadata_document_supported).toBe(true);
  });

  test("publishes the keys that verify an access token", async () => {
    const response = await fetch(`${server.origin}/api/auth/jwks`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { keys: unknown[] };
    expect(body.keys.length).toBeGreaterThan(0);
  });
});

describe("authorization", () => {
  test("answers a request with no token with the RFC 9728 challenge", async () => {
    const response = await fetch(`${server.origin}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(response.status).toBe(401);
    const challenge = response.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain("Bearer");
    expect(challenge).toContain(
      `resource_metadata="${server.origin}/.well-known/oauth-protected-resource/mcp"`,
    );
    // A client that takes this challenge as the list of scopes to request gets
    // a read-only token when the challenge names only the scope needed to
    // connect. Claude does exactly that.
    expect(challenge).toContain('scope="artifacts:read artifacts:write"');
  });

  test("refuses a token this server did not sign", async () => {
    const forged = `${client.accessToken.split(".").slice(0, 2).join(".")}.not-the-signature`;
    const response = await client.call(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      {
        token: forged,
      },
    );
    expect(response.status).toBe(401);
  });

  test("binds the token to this MCP URL", async () => {
    const [header, payload, signature] = client.accessToken.split(".");
    expect(header).toBeDefined();
    expect(signature).toBeDefined();
    const claims = JSON.parse(Buffer.from(payload ?? "", "base64url").toString()) as {
      aud: string;
      iss: string;
      scope: string;
    };
    expect(claims.aud).toBe(`${server.origin}/mcp`);
    expect(claims.iss).toBe(`${server.origin}/api/auth`);
    expect(claims.scope).toBe("artifacts:read artifacts:write");
  });

  test("refuses a token whose user the admission policy no longer admits", async () => {
    const own = await createLiveTestServer();
    try {
      const ownCookie = await own.signIn();
      const ownClient = await authorizeClient(own, {
        cookie: ownCookie,
        clientId: await registerClient(own, ownCookie),
      });
      expect((await ownClient.call({ jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(
        200,
      );

      // The same identity, moved out of the allowed domain.
      own.database.query('update "user" set email = ?').run("person@example.com");

      const response = await ownClient.call({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      expect(response.status).toBe(403);
    } finally {
      own.stop();
    }
  });
});

describe("transport", () => {
  test("refuses a request from an origin this deployment does not serve", async () => {
    const response = await fetch(`${server.origin}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${client.accessToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        origin: "https://attacker.example",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  test("refuses a stream request rather than holding one open for no session", async () => {
    const response = await fetch(`${server.origin}/mcp`, {
      headers: { authorization: `Bearer ${client.accessToken}`, accept: "text/event-stream" },
    });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    await response.text();
  });
});

describe("tools", () => {
  test("offers the artifact tools", async () => {
    expect(await tools()).toEqual([
      "list_artifacts",
      "search_artifacts",
      "get_artifact_metadata",
      "list_artifact_versions",
      "get_artifact_source",
      "upload_artifact",
      "create_upload_ticket",
      "set_artifact_status",
      "set_artifact_visibility",
      "list_artifact_comments",
      "add_artifact_comment",
      "list_artifact_entries",
      "set_artifact_entry",
      "clear_artifact_entry",
      "list_folders",
      "create_folder",
      "update_folder",
      "delete_folder",
      "list_tags",
      "create_tag",
      "update_tag",
      "delete_tag",
      "set_artifact_organization",
      "get_artifact_markdown",
    ]);
  });

  test("states that artifact HTML is untrusted and bounded", async () => {
    const response = await client.call({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const body = (await response.json()) as {
      result: { tools: { name: string; description: string }[] };
    };
    // The tools that carry artifact HTML say what it is. The status and
    // comment tools carry no HTML.
    const carriesHtml = body.result.tools.filter((tool) =>
      [
        "list_artifacts",
        "get_artifact_metadata",
        "get_artifact_source",
        "upload_artifact",
      ].includes(tool.name),
    );
    expect(carriesHtml).toHaveLength(4);
    for (const tool of carriesHtml) {
      expect(tool.description).toContain("untrusted");
      expect(tool.description).toContain("5 MiB");
    }
  });

  test("refuses a known title without artifactId and names the artifact that has it", async () => {
    const created = await upload("Titled through MCP");
    const refused = await callTool(client, "upload_artifact", {
      title: "Titled through MCP",
      html: "<!doctype html><html><title>t</title>revised</html>",
    });
    expect(refused.result?.isError).toBe(true);
    const text = JSON.stringify(refused.result?.content);
    expect(text).toContain("TITLE_EXISTS");
    // The agent needs the id to offer the user a new version of that artifact.
    expect(text).toContain(created.id);
  });

  test("uploads with artifactId as a new version and lists the versions", async () => {
    const created = await upload("Versioned through MCP");
    const again = (
      await callTool(client, "upload_artifact", {
        title: "Versioned through MCP",
        artifactId: created.id,
        html: "<!doctype html><html><title>t</title>revised</html>",
      })
    ).result?.structuredContent as { id: string; versionNumber: number; newArtifact: boolean };
    expect(again.id).toBe(created.id);
    expect(again.versionNumber).toBe(2);
    expect(again.newArtifact).toBe(false);

    const versions = (await callTool(client, "list_artifact_versions", { id: created.id })).result
      ?.structuredContent as { versions: { id: string; number: number }[] };
    expect(versions.versions.map((version) => version.number)).toEqual([2, 1]);

    const first = versions.versions[1];
    const source = (
      await callTool(client, "get_artifact_source", { id: created.id, versionId: first?.id })
    ).result?.structuredContent as { html: string; versionNumber: number };
    expect(source.versionNumber).toBe(1);
    expect(source.html).toContain("hi");
  });

  test("an agent can make its user's artifact private, and another user's agent cannot read it", async () => {
    const created = (
      await callTool(client, "upload_artifact", {
        title: "Private through MCP",
        html: "<!doctype html><html><title>t</title>hi</html>",
        visibility: "private",
      })
    ).result?.structuredContent as { id: string };
    const shared = (
      await callTool(client, "set_artifact_visibility", { id: created.id, visibility: "shared" })
    ).result?.structuredContent as { visibility: string };
    expect(shared.visibility).toBe("shared");
    const hidden = (
      await callTool(client, "set_artifact_visibility", { id: created.id, visibility: "private" })
    ).result?.structuredContent as { visibility: string };
    expect(hidden.visibility).toBe("private");

    const otherCookie = await server.signIn({
      ...WORKSPACE_USER,
      sub: "google-subject-mcp-other",
      email: "mcp-other@acme.example",
      name: "Another Person",
    });
    const otherClient = await authorizeClient(server, {
      cookie: otherCookie,
      clientId: await registerClient(server, otherCookie),
    });
    for (const [tool, args] of [
      ["get_artifact_metadata", { id: created.id }],
      ["get_artifact_source", { id: created.id }],
      ["list_artifact_comments", { id: created.id }],
      ["set_artifact_visibility", { id: created.id, visibility: "shared" }],
    ] as const) {
      const refused = await callTool(otherClient, tool, args);
      expect(refused.result?.isError, tool).toBe(true);
      const text = JSON.stringify(refused.result?.content);
      expect(text, tool).toContain("PRIVATE");
      expect(text, tool).not.toContain("person@acme.example");
    }
    const listed = (await callTool(otherClient, "list_artifacts", { query: "Private through MCP" }))
      .result?.structuredContent as { items: unknown[] };
    expect(listed.items).toHaveLength(0);
    const searched = (
      await callTool(otherClient, "search_artifacts", { query: "Private through MCP" })
    ).result?.structuredContent as { total: number; artifacts: unknown[] };
    expect(searched).toMatchObject({ total: 0, artifacts: [] });
  });

  test("searches artifact text and comments, and says where each matched", async () => {
    const created = await upload(
      "Searched through MCP",
      "<!doctype html><html><title>t</title><p>Start the zanzibar rollback.</p></html>",
    );
    await callTool(client, "add_artifact_comment", { id: created.id, body: "zanzibar again?" });

    const found = (await callTool(client, "search_artifacts", { query: "zanzibar" })).result
      ?.structuredContent as {
      total: number;
      content: { id: string; title: string; url: string; snippet: string; matches: number }[];
      comments: { id: string; snippet: string }[];
    };
    // One artifact, found in its text and in a comment.
    expect(found.total).toBe(1);
    expect(found.content).toEqual([
      {
        id: created.id,
        title: "Searched through MCP",
        url: created.url,
        snippet: "Start the **zanzibar** rollback.",
        matches: 1,
      },
    ]);
    expect(found.comments.map((comment) => comment.snippet)).toEqual(["**zanzibar** again?"]);
  });

  test("moves status and archives through MCP, recording the caller", async () => {
    const created = await upload("Status through MCP");

    const solved = (
      await callTool(client, "set_artifact_status", { id: created.id, status: "solved" })
    ).result?.structuredContent as { status: string };
    expect(solved.status).toBe("solved");

    const archived = (
      await callTool(client, "set_artifact_status", {
        id: created.id,
        archived: true,
      })
    ).result?.structuredContent as { status: string; archivedAt: string | null };
    expect(archived.status).toBe("solved");
    expect(archived.archivedAt).not.toBeNull();

    const listed = (await callTool(client, "list_artifacts", { query: "Status through MCP" }))
      .result?.structuredContent as { items: unknown[] };
    expect(listed.items).toHaveLength(0);

    const withArchived = (
      await callTool(client, "list_artifacts", {
        query: "Status through MCP",
        includeArchived: true,
      })
    ).result?.structuredContent as { items: { id: string }[] };
    expect(withArchived.items[0]?.id).toBe(created.id);
  });

  test("organizes artifacts through MCP without changing the global listing", async () => {
    const folder = (await callTool(client, "create_folder", { name: "Research" })).result
      ?.structuredContent as { id: string };
    const tag = (await callTool(client, "create_tag", { name: "Urgent" })).result
      ?.structuredContent as { id: string };
    const created = await upload("Organized through MCP");

    const organized = (
      await callTool(client, "set_artifact_organization", {
        id: created.id,
        folderId: folder.id,
        tagIds: [tag.id],
      })
    ).result?.structuredContent as { folder: { id: string } | null; tags: { id: string }[] };
    expect(organized.folder?.id).toBe(folder.id);
    expect(organized.tags.map((entry) => entry.id)).toEqual([tag.id]);

    const inFolder = (await callTool(client, "list_artifacts", { folderId: folder.id })).result
      ?.structuredContent as { items: { id: string }[] };
    expect(inFolder.items.map((item) => item.id)).toContain(created.id);

    const global = (await callTool(client, "list_artifacts", { query: "Organized through MCP" }))
      .result?.structuredContent as { items: { id: string }[] };
    expect(global.items.map((item) => item.id)).toContain(created.id);
  });

  test("files an upload in the folder and tags it names", async () => {
    const folder = (await callTool(client, "create_folder", { name: "Filed at upload" })).result
      ?.structuredContent as { id: string };
    const tag = (await callTool(client, "create_tag", { name: "Filed" })).result
      ?.structuredContent as { id: string };
    const uploaded = (
      await callTool(client, "upload_artifact", {
        title: "Filed through MCP",
        html: "<!doctype html><html><title>t</title>hi</html>",
        folderId: folder.id,
        tagIds: [tag.id],
      })
    ).result?.structuredContent as { id: string };

    const metadata = (await callTool(client, "get_artifact_metadata", { id: uploaded.id })).result
      ?.structuredContent as { folder: { id: string } | null; tags: { id: string }[] };
    expect(metadata.folder?.id).toBe(folder.id);
    expect(metadata.tags.map((entry) => entry.id)).toEqual([tag.id]);
  });

  test("adds and reads comments, recording the caller as the author", async () => {
    const created = await upload("Comment through MCP");
    await callTool(client, "add_artifact_comment", { id: created.id, body: "From a client" });

    const comments = (await callTool(client, "list_artifact_comments", { id: created.id })).result
      ?.structuredContent as {
      comments: { body: string; author: { email: string }; anchor: unknown }[];
    };
    expect(comments.comments[0]?.body).toBe("From a client");
    expect(comments.comments[0]?.author.email).toBe("person@acme.example");
    expect(comments.comments[0]?.anchor).toBeNull();
  });

  test("records entries as the caller, checks them against the page's schema, and clears them", async () => {
    const schema = {
      keys: { "vote:{item}": { params: { item: { enum: ["P-01"] } }, value: { const: true } } },
    };
    const created = await upload(
      "Entries through MCP",
      `<!doctype html><html><head><title>t</title><script type="application/json" id="portego-entries">${JSON.stringify(schema)}</script></head><body>hi</body></html>`,
    );

    const set = await callTool(client, "set_artifact_entry", {
      id: created.id,
      key: "vote:P-01",
      value: true,
    });
    expect(set.result?.structuredContent).toMatchObject({
      key: "vote:P-01",
      value: true,
      author: { email: "person@acme.example" },
    });

    const refused = await callTool(client, "set_artifact_entry", {
      id: created.id,
      key: "vote:P-02",
      value: true,
    });
    expect(refused.result?.isError).toBe(true);
    expect(JSON.stringify(refused.result?.content)).toContain("INVALID_INPUT");

    const listed = (await callTool(client, "list_artifact_entries", { id: created.id })).result
      ?.structuredContent as { entries: { key: string }[]; schema: unknown };
    expect(listed.entries.map((entry) => entry.key)).toEqual(["vote:P-01"]);
    expect(listed.schema).toEqual(schema);

    await callTool(client, "clear_artifact_entry", { id: created.id, key: "vote:P-01" });
    const cleared = (await callTool(client, "list_artifact_entries", { id: created.id })).result
      ?.structuredContent as { entries: unknown[] };
    expect(cleared.entries).toEqual([]);
  });

  test("anchors a comment to a passage of text and reads it back", async () => {
    const created = await upload("Anchored comment through MCP");
    const anchor = { quote: "the important part", prefix: "before ", suffix: " after" };
    await callTool(client, "add_artifact_comment", { id: created.id, body: "Anchored", anchor });

    const comments = (await callTool(client, "list_artifact_comments", { id: created.id })).result
      ?.structuredContent as { comments: { anchor: typeof anchor | null }[] };
    expect(comments.comments[0]?.anchor).toEqual(anchor);
  });

  test("refuses an anchor with an empty quote", async () => {
    const created = await upload("Bad anchor through MCP");
    const result = await callTool(client, "add_artifact_comment", {
      id: created.id,
      body: "Anchored",
      anchor: { quote: "   ", prefix: "", suffix: "" },
    });
    expect(result.result?.isError).toBe(true);
    expect(JSON.stringify(result.result?.content)).toContain("INVALID_INPUT");
  });

  test("replies to a comment and reads the reply back with its parentId", async () => {
    const created = await upload("Thread through MCP");
    const root = (await callTool(client, "add_artifact_comment", { id: created.id, body: "Root" }))
      .result?.structuredContent as { id: string };

    const added = (
      await callTool(client, "add_artifact_comment", {
        id: created.id,
        body: "A reply",
        parentId: root.id,
      })
    ).result?.structuredContent as { parentId: string | null };
    expect(added.parentId).toBe(root.id);

    const comments = (await callTool(client, "list_artifact_comments", { id: created.id })).result
      ?.structuredContent as { comments: { body: string; parentId: string | null }[] };
    expect(comments.comments.find((entry) => entry.body === "A reply")?.parentId).toBe(root.id);
  });

  test("records the authenticated user as the creator of an upload", async () => {
    const created = await upload("Creator check");
    const artifact = server.artifacts.get(created.id, { userId: null });
    const session = await server.auth.api.getSession({ headers: new Headers({ cookie }) });

    expect(artifact.creator.id).toBe(session?.user.id ?? "");
    expect(artifact.creator.email).toBe("person@acme.example");
  });

  test("ignores a user id passed as a tool argument", async () => {
    const result = await callTool(client, "upload_artifact", {
      title: "Impersonation attempt",
      html: "<!doctype html><html><title>t</title></html>",
      createdBy: "someone-else",
      userId: "someone-else",
    });
    const created = result.result?.structuredContent as { id: string };
    expect(server.artifacts.get(created.id, { userId: null }).creator.email).toBe(
      "person@acme.example",
    );
  });

  test("lists, reads, and returns the source of an artifact it stored", async () => {
    const html = "<!doctype html><html><title>Round trip</title><p>content</p></html>";
    const created = await upload("Round trip", html);

    const listed = (await callTool(client, "list_artifacts", { query: "Round trip" })).result
      ?.structuredContent as { items: { id: string; url: string }[] };
    expect(listed.items[0]?.id).toBe(created.id);
    expect(listed.items[0]?.url).toBe(`${server.origin}/a/${created.id}`);

    const metadata = (await callTool(client, "get_artifact_metadata", { id: created.id })).result
      ?.structuredContent as { title: string; sha256: string };
    expect(metadata.title).toBe("Round trip");
    expect(metadata.sha256).toBe(created.sha256);

    const source = (await callTool(client, "get_artifact_source", { id: created.id })).result
      ?.structuredContent as { html: string };
    expect(source.html).toBe(html);
  });

  test("reports a missing artifact as a tool error, not as a crash", async () => {
    const result = await callTool(client, "get_artifact_metadata", { id: "does-not-exist" });
    expect(result.result?.isError).toBe(true);
    expect(JSON.stringify(result.result?.content)).toContain("NOT_FOUND");
  });

  test("refuses an upload the service would refuse", async () => {
    const result = await callTool(client, "upload_artifact", {
      title: "Not HTML",
      html: "id,name\n1,a\n",
    });
    expect(result.result?.isError).toBe(true);
    expect(JSON.stringify(result.result?.content)).toContain("UNSUPPORTED_CONTENT");
  });

  test("refuses arguments that do not match the schema", async () => {
    const result = await callTool(client, "list_artifacts", { limit: 1000 });
    expect(result.result?.isError ?? Boolean(result.error)).toBe(true);
  });

  test("returns an artifact's static content as Markdown", async () => {
    const created = await upload(
      "Markdown check",
      "<!doctype html><html><title>t</title><h1>Heading</h1><p>text</p><script>run()</script></html>",
    );

    const result = (await callTool(client, "get_artifact_markdown", { id: created.id })).result
      ?.structuredContent as { markdown: string; empty: boolean; source: string };
    expect(result.markdown).toBe("# Heading\n\ntext");
    expect(result.empty).toBe(false);
    expect(result.source).toBe("generated");
  });

  test("returns the Markdown sent with HTML instead of converting the HTML", async () => {
    const result = await callTool(client, "upload_artifact", {
      title: "Companion check",
      html: "<!doctype html><html><title>t</title><svg><text>42%</text></svg></html>",
      markdown: "# Companion check\n\nConversion is 42%.",
    });
    const created = result.result?.structuredContent as { id: string };
    const markdown = (await callTool(client, "get_artifact_markdown", { id: created.id })).result
      ?.structuredContent as { markdown: string; source: string };
    expect(markdown).toMatchObject({
      markdown: "# Companion check\n\nConversion is 42%.",
      source: "provided",
    });
  });

  test("renders Markdown and returns the supplied source", async () => {
    const result = await callTool(client, "upload_artifact", {
      title: "Markdown render check",
      markdown: "# Heading\n\nA **fact**.",
    });
    const created = result.result?.structuredContent as { id: string };
    const markdown = (await callTool(client, "get_artifact_markdown", { id: created.id })).result
      ?.structuredContent as {
      id: string;
      markdown: string;
      empty: boolean;
      source: string;
      converterVersion: string;
    };
    const html = (await callTool(client, "get_artifact_source", { id: created.id })).result
      ?.structuredContent as { html: string };

    expect(markdown).toEqual({
      id: created.id,
      markdown: "# Heading\n\nA **fact**.",
      empty: false,
      source: "provided",
      converterVersion: "provided",
    });
    expect(html.html).toContain("<strong>fact</strong>");
  });

  test("says an artifact has no static content rather than inventing some", async () => {
    const created = await upload(
      "Rendered by script",
      '<!doctype html><html><title>t</title><div id="root"></div><script>render()</script></html>',
    );

    const result = (await callTool(client, "get_artifact_markdown", { id: created.id })).result
      ?.structuredContent as { markdown: string; empty: boolean };
    expect(result.empty).toBe(true);
    expect(result.markdown).toBe("");
  });

  // The point of a ticket is that the bytes never travel as a tool argument,
  // so the test that matters is whether the issued ticket actually uploads.
  test("issues a ticket that uploads a file, crediting the token's user", async () => {
    const issued = (await callTool(client, "create_upload_ticket")).result?.structuredContent as {
      url: string;
      ticket: string;
      method: string;
      maxBytes: number;
      maxImages: number;
      maxImageBytesTotal: number;
    };
    expect(issued.url).toBe(`${server.origin}/api/uploads`);
    expect(issued.method).toBe("POST");
    expect(issued.maxBytes).toBe(server.artifacts.maxUploadBytes);
    // The local tool checks images against these before it sends any bytes.
    expect(issued.maxImages).toBe(server.artifacts.maxImages);
    expect(issued.maxImageBytesTotal).toBe(server.artifacts.maxImageBytesTotal);

    const form = new FormData();
    form.set(
      "file",
      new File(["<!doctype html><html><title>t</title>from a file</html>"], "p.html"),
    );
    form.set("title", "Uploaded with a ticket");
    const response = await fetch(issued.url, {
      method: "POST",
      headers: { authorization: `Bearer ${issued.ticket}` },
      body: form,
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      artifact: { title: string; creator: { email: string } };
    };
    expect(body.artifact.title).toBe("Uploaded with a ticket");
    expect(body.artifact.creator.email).toBe("person@acme.example");
  });

  test("refuses an upload whose ticket this deployment did not issue", async () => {
    const form = new FormData();
    form.set("file", new File(["<!doctype html><html><title>t</title>x</html>"], "p.html"));
    const response = await fetch(`${server.origin}/api/uploads`, {
      method: "POST",
      headers: { authorization: "Bearer v1.dXNlcg.99999999999.not-a-signature" },
      body: form,
    });
    expect(response.status).toBe(401);
  });
});

describe("logging", () => {
  test("never writes artifact HTML to the log", async () => {
    const secret = "SECRET-MARKER-IN-ARTIFACT-HTML";
    const written: string[] = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    const capture = (...args: unknown[]) => written.push(args.map(String).join(" "));
    console.log = capture;
    console.warn = capture;
    console.error = capture;

    try {
      await callTool(client, "upload_artifact", {
        title: "Log check",
        html: `<!doctype html><html><title>t</title><p>${secret}</p></html>`,
      });
      // A refusal must not log the document either.
      await callTool(client, "upload_artifact", { title: "Log check", html: secret });
    } finally {
      console.log = original.log;
      console.warn = original.warn;
      console.error = original.error;
    }

    expect(written.join("\n")).not.toContain(secret);
  });
});

describe("scopes", () => {
  test("a read-only token cannot create an artifact", async () => {
    const own = await createLiveTestServer();
    try {
      const ownCookie = await own.signIn();
      const readOnly = await authorizeClient(own, {
        cookie: ownCookie,
        clientId: await registerClient(own, ownCookie, "artifacts:read"),
        scope: "artifacts:read",
      });
      expect(readOnly.scope).toBe("artifacts:read");

      const result = await callTool(readOnly, "upload_artifact", {
        title: "Should not be stored",
        html: "<!doctype html><html><title>t</title></html>",
      });
      expect(result.result?.isError).toBe(true);
      expect(JSON.stringify(result.result?.content)).toContain("insufficient_scope");
      expect(own.artifacts.list({ userId: null }).items).toHaveLength(0);

      // The same rule covers every write tool, not only uploads.
      for (const tool of [
        "set_artifact_status",
        "set_artifact_visibility",
        "add_artifact_comment",
        "create_upload_ticket",
        "set_artifact_entry",
        "clear_artifact_entry",
      ]) {
        const refused = await callTool(readOnly, tool, {
          id: "any",
          body: "x",
          status: "solved",
          visibility: "private",
          key: "x",
          value: 1,
        });
        expect(JSON.stringify(refused.result?.content), tool).toContain("insufficient_scope");
      }
    } finally {
      own.stop();
    }
  });
});

describe("staying signed in", () => {
  const SCOPE = "artifacts:read artifacts:write offline_access";
  const GRANTS = ["authorization_code", "refresh_token"];

  async function refresh(clientId: string, refreshToken: string) {
    const response = await fetch(`${server.origin}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { origin: server.origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        resource: `${server.origin}/mcp`,
      }),
    });
    return (await response.json()) as { access_token?: string; refresh_token?: string };
  }

  // Without a refresh token a client has to send its user back to the browser
  // every hour, when the access token expires.
  test("a client that asks for offline_access renews its token without the browser", async () => {
    const clientId = await registerClient(server, cookie, SCOPE, GRANTS);
    const offline = await authorizeClient(server, { cookie, clientId, scope: SCOPE });
    expect(offline.refreshToken).toBeString();

    const renewed = await refresh(clientId, offline.refreshToken ?? "");
    expect(renewed.access_token).toBeString();
    expect(renewed.refresh_token).toBeString();
    expect(renewed.refresh_token).not.toBe(offline.refreshToken);

    const response = await offline.call(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { token: renewed.access_token },
    );
    expect(response.status).toBe(200);

    // The rotated token gets a full week of its own, so the week counts from
    // the last use and not from the sign-in.
    const live = server.database
      .query(
        "select createdAt, expiresAt from oauthRefreshToken where clientId = ? and revoked is null",
      )
      .all(clientId) as { createdAt: string; expiresAt: string }[];
    expect(live).toHaveLength(1);
    const lifetime = Date.parse(live[0]?.expiresAt ?? "") - Date.parse(live[0]?.createdAt ?? "");
    expect(lifetime).toBe(7 * 24 * 60 * 60 * 1000);
  });

  test("a client that does not ask for offline_access gets no refresh token", async () => {
    const clientId = await registerClient(server, cookie, "artifacts:read artifacts:write", GRANTS);
    const online = await authorizeClient(server, { cookie, clientId });
    expect(online.refreshToken).toBeUndefined();
  });
});

describe("a deployment without private artifacts", () => {
  let closed: LiveTestServer;
  let agent: McpClient;

  beforeAll(async () => {
    closed = await createLiveTestServer({ privateArtifacts: false });
    const owner = await closed.signIn();
    agent = await authorizeClient(closed, {
      cookie: owner,
      clientId: await registerClient(closed, owner),
    });
  });

  afterAll(() => {
    closed.stop();
  });

  test("offers agents no way to make an artifact private", async () => {
    const response = await agent.call({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const body = (await response.json()) as {
      result: {
        tools: { name: string; description: string; inputSchema: { properties: object } }[];
      };
    };
    const names = body.result.tools.map((tool) => tool.name);
    expect(names).not.toContain("set_artifact_visibility");
    const upload = body.result.tools.find((tool) => tool.name === "upload_artifact");
    expect(Object.keys(upload?.inputSchema.properties ?? {})).not.toContain("visibility");
    for (const tool of body.result.tools) expect(tool.description).not.toMatch(/private/i);
  });
});
