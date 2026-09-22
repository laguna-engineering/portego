import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
      "finalize_artifact",
      "get_artifact_style",
      "prepare_artifact_draft",
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
