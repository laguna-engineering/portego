import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let directory: string;
let client: Client;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "portego-upload-"));
  await writeFile(join(directory, "page.html"), "<!doctype html><title>t</title>");
  client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: "bun",
      args: ["run", join(import.meta.dir, "index.ts")],
      // No PORTEGO_ORIGIN and an empty credentials path: a first run.
      env: { PATH: process.env.PATH ?? "", PORTEGO_CREDENTIALS: join(directory, "c.json") },
    }),
  );
});

afterAll(async () => {
  await client.close();
  await rm(directory, { recursive: true, force: true });
});

async function uploadError(): Promise<string> {
  const result = (await client.callTool({
    name: "upload_artifact_from_path",
    arguments: { path: join(directory, "page.html") },
  })) as { isError?: boolean; content: { text: string }[] };
  expect(result.isError).toBe(true);
  return result.content[0]?.text ?? "";
}

test("uses a positional argument after a flag value", async () => {
  const path = join(directory, "draft.html");
  const child = Bun.spawn(
    ["bun", "run", join(import.meta.dir, "index.ts"), "prepare", "--title", "Q3 Report", path],
    { env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" },
  );
  expect(await child.exited).toBe(0);
  expect(await Bun.file(path).exists()).toBe(true);
});

// A client shows this version to the person, who compares it with the npm
// package and with the plugin to see which release is running.
test("reports the version of the package, which the plugin shares", async () => {
  const packageJson = await Bun.file(join(import.meta.dir, "package.json")).json();
  const plugin = await Bun.file(
    join(import.meta.dir, "../../plugins/portego-upload/.claude-plugin/plugin.json"),
  ).json();
  expect(client.getServerVersion()?.version).toBe(packageJson.version);
  expect(plugin.version).toBe(packageJson.version);
});

// An MCP client shows a server that exits at startup as "failed" and the agent
// never learns why, so nobody is told how to set the tool up.
describe("a first run with no deployment set", () => {
  test("the server starts and tells the agent what the user has to run", async () => {
    expect(await uploadError()).toContain("auth <origin>");
  });

  test("offers sign_in, which takes no address an injected prompt could choose", async () => {
    const { tools } = await client.listTools();
    const signIn = tools.find((tool) => tool.name === "sign_in");
    expect(signIn?.inputSchema.properties ?? {}).toEqual({});
  });

  test("offers local style and validation tools before setup", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "add_artifact_comment",
      "download_artifact_source",
      "finalize_artifact",
      "get_artifact_markdown",
      "get_artifact_style",
      "list_artifact_comments",
      "list_artifacts",
      "list_folders",
      "list_tags",
      "prepare_artifact_draft",
      "search_artifacts",
      "sign_in",
      "upload_artifact_from_path",
      "validate_artifact",
    ]);

    const result = (await client.callTool({
      name: "validate_artifact",
      arguments: { path: join(directory, "page.html") },
    })) as { isError?: boolean; structuredContent?: { valid?: boolean } };
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent?.valid).toBe(true);
  });

  test("a setup done while the server runs is picked up without a restart", async () => {
    await writeFile(
      join(directory, "c.json"),
      JSON.stringify({ defaultOrigin: "https://main.example", tokens: {} }),
    );
    expect(await uploadError()).toContain("Not signed in to https://main.example");
  });
});

describe("reading an artifact from a signed-in deployment", () => {
  const html = "<!doctype html><title>Plans</title><p>Acqua alta</p>";
  const calls: { name: string; arguments: Record<string, unknown>; authorization: string }[] = [];
  let deployment: ReturnType<typeof Bun.serve>;
  let reader: Client;

  beforeAll(async () => {
    deployment = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const { params } = (await request.json()) as {
          params: { name: string; arguments: Record<string, unknown> };
        };
        calls.push({ ...params, authorization: request.headers.get("authorization") ?? "" });
        const structuredContent =
          params.name === "get_artifact_source"
            ? { id: "a1", versionId: "v2", versionNumber: 2, sha256: "s", byteSize: 51, html }
            : { id: "a1", markdown: "Acqua alta", empty: false, source: "generated" };
        return Response.json({ jsonrpc: "2.0", id: 1, result: { structuredContent } });
      },
    });
    const origin = `http://127.0.0.1:${deployment.port}`;
    const credentials = join(directory, "signed-in.json");
    await writeFile(
      credentials,
      JSON.stringify({ tokens: { [origin]: { accessToken: "token", expiresAt: 4102444800 } } }),
    );
    reader = new Client({ name: "test", version: "0" });
    await reader.connect(
      new StdioClientTransport({
        command: "bun",
        args: ["run", join(import.meta.dir, "index.ts")],
        env: {
          PATH: process.env.PATH ?? "",
          PORTEGO_ORIGIN: origin,
          PORTEGO_CREDENTIALS: credentials,
        },
      }),
    );
  });

  afterAll(async () => {
    await reader.close();
    deployment.stop(true);
  });

  // An agent changes a page by editing a local file and uploading it again, so
  // the page goes to disk and its bytes stay out of the conversation.
  test("download_artifact_source writes the HTML to the file and returns only the record", async () => {
    const path = join(directory, "plans.html");
    const result = (await reader.callTool({
      name: "download_artifact_source",
      arguments: { id: "a1", path, versionId: "v2" },
    })) as { isError?: boolean; content: { text: string }[]; structuredContent?: unknown };

    expect(result.isError).not.toBe(true);
    expect(await readFile(path, "utf8")).toBe(html);
    expect(result.structuredContent).toEqual({
      path,
      id: "a1",
      versionId: "v2",
      versionNumber: 2,
      sha256: "s",
      byteSize: 51,
    });
    expect(result.content[0]?.text).not.toContain("Acqua alta");
    expect(calls.at(-1)).toEqual({
      name: "get_artifact_source",
      arguments: { id: "a1", versionId: "v2" },
      authorization: "Bearer token",
    });
  });

  // A file the agent already edited must survive a second download.
  test("download_artifact_source keeps an existing file unless told to overwrite it", async () => {
    const path = join(directory, "edited.html");
    await writeFile(path, "edited");
    const refused = (await reader.callTool({
      name: "download_artifact_source",
      arguments: { id: "a1", path },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toContain("already exists");
    expect(await readFile(path, "utf8")).toBe("edited");

    await reader.callTool({
      name: "download_artifact_source",
      arguments: { id: "a1", path, overwrite: true },
    });
    expect(await readFile(path, "utf8")).toBe(html);
  });

  test("get_artifact_markdown returns the deployment's Markdown", async () => {
    const result = (await reader.callTool({
      name: "get_artifact_markdown",
      arguments: { id: "a1" },
    })) as { structuredContent?: { markdown?: string } };
    expect(result.structuredContent?.markdown).toBe("Acqua alta");
    expect(calls.at(-1)?.arguments).toEqual({ id: "a1" });
  });
});
