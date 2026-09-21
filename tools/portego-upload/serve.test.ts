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

  test("a setup done while the server runs is picked up without a restart", async () => {
    await writeFile(
      join(directory, "c.json"),
      JSON.stringify({ defaultOrigin: "https://main.example", tokens: {} }),
    );
    expect(await uploadError()).toContain("Not signed in to https://main.example");
  });
});
