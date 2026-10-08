import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { GenerateError, generate, renameProse, validateOptions } from "./generate.ts";

const ACME = { name: "Acme Share", slug: "acme-share", packageName: "@acme/share-upload" };

let directory: string;
/** Generated with --origin and --style. */
let full: string;
/** Generated with names only, as a company that has not chosen a deployment yet. */
let bare: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "portego-generate-"));
  const style = join(directory, "acme-style");
  await mkdir(style);
  await writeFile(
    join(style, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      name: "Acme",
      extends: "portego",
      instructions: "DESIGN.md",
      styles: ["tokens.css"],
    }),
  );
  await writeFile(join(style, "DESIGN.md"), "Use Acme red for accents.\n");
  await writeFile(join(style, "tokens.css"), ":root { --accent: #b5361f; }\n");

  full = join(directory, "full");
  bare = join(directory, "bare");
  await generate({ ...ACME, origin: "https://share.acme.example/", style, out: full });
  await generate({ ...ACME, out: bare });
}, 60_000);

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

const plugin = (root: string) => join(root, "plugins", "acme-share-upload");
const bundle = (root: string) => join(plugin(root), "server", "acme-share-upload.js");

/** A machine with no deployment, credentials, or style of its own. */
async function cleanEnvironment(): Promise<Record<string, string>> {
  const home = await mkdtemp(join(directory, "home-"));
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    XDG_CONFIG_HOME: home,
    PORTEGO_CREDENTIALS: join(home, "credentials.json"),
  };
}

/** Runs a generated bundle the way the plugin and npx start it: with node. */
async function run(root: string, args: string[]) {
  const child = Bun.spawn(["node", bundle(root), ...args], {
    cwd: directory,
    env: await cleanEnvironment(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = [
    await new Response(child.stdout).text(),
    await new Response(child.stderr).text(),
  ];
  return { code: await child.exited, stdout, stderr };
}

describe("validateOptions", () => {
  test("refuses names that would break a plugin, command, or package name", () => {
    const valid = { ...ACME, out: "x" };
    expect(() => validateOptions({ ...valid, slug: "Acme Share" })).toThrow(GenerateError);
    expect(() => validateOptions({ ...valid, slug: "acme--share" })).toThrow(GenerateError);
    expect(() => validateOptions({ ...valid, packageName: "Acme" })).toThrow(GenerateError);
    expect(() => validateOptions({ ...valid, name: "Acme\nShare" })).toThrow(GenerateError);
  });

  test("accepts only an https origin, and drops any path from it", () => {
    const valid = { ...ACME, out: "x" };
    expect(() => validateOptions({ ...valid, origin: "http://share.acme.example" })).toThrow(
      GenerateError,
    );
    expect(validateOptions({ ...valid, origin: "https://share.acme.example/x" }).origin).toBe(
      "https://share.acme.example",
    );
  });
});

describe("renameProse", () => {
  test("renames the product and its command, and keeps the page API a deployed page calls", () => {
    const text =
      "Portego gives the page `window.portego.set` and `portego:entries`. " +
      "Mark it <style data-portego-style>. Run npx -y portego-upload auth.";
    expect(renameProse(text, { ...ACME })).toBe(
      "Acme Share gives the page `window.portego.set` and `portego:entries`. " +
        "Mark it <style data-portego-style>. Run npx -y @acme/share-upload auth.",
    );
  });
});

describe("generate", () => {
  test("refuses to write into a directory that holds anything, so it never mixes two builds", async () => {
    await expect(generate({ ...ACME, out: full })).rejects.toThrow(GenerateError);
  });

  test("refuses a style the tool could not load", async () => {
    const out = join(directory, "bad-style");
    await expect(generate({ ...ACME, style: join(directory, "missing"), out })).rejects.toThrow();
  });

  test("writes a marketplace whose plugin runs the renamed server with the same settings", async () => {
    const marketplace = JSON.parse(
      await readFile(join(full, ".claude-plugin", "marketplace.json"), "utf8"),
    );
    expect(marketplace.plugins).toEqual([
      expect.objectContaining({ name: "acme-share-upload", source: "./plugins/acme-share-upload" }),
    ]);

    const manifest = JSON.parse(
      await readFile(join(plugin(full), ".claude-plugin", "plugin.json"), "utf8"),
    );
    const packageJson = JSON.parse(await readFile(join(import.meta.dir, "package.json"), "utf8"));
    expect(manifest.name).toBe("acme-share-upload");
    expect(manifest.version).toBe(packageJson.version);
    expect(Object.keys(manifest.mcpServers)).toEqual(["acme-share-upload"]);
    const server = manifest.mcpServers["acme-share-upload"];
    expect(server.args).toEqual([`\${CLAUDE_PLUGIN_ROOT}/server/acme-share-upload.js`]);
    expect(await Bun.file(bundle(full)).exists()).toBe(true);
    // The tool reads these names, so a renamed plugin keeps them.
    expect(Object.keys(server.env)).toEqual(["PORTEGO_ORIGIN", "PORTEGO_ARTIFACT_STYLE"]);
    expect(manifest.userConfig.origin.title).toBe("Acme Share deployment");
    expect(manifest.userConfig.origin.description).toContain("https://share.acme.example");
  });

  test("leaves no product name in what Claude reads, and keeps the page API", async () => {
    const skills = join(plugin(full), "skills");
    for (const name of await readdir(skills)) {
      const text = await readFile(join(skills, name, "SKILL.md"), "utf8");
      expect(text).not.toContain("Portego");
    }
    const create = await readFile(join(skills, "create-artifact", "SKILL.md"), "utf8");
    expect(create).toContain("window.portego");
    const design = await readFile(
      join(plugin(full), "server", "style", "portego", "DESIGN.md"),
      "utf8",
    );
    expect(design).not.toContain("Portego");
  });

  test("writes an npm package whose command is the renamed bundle", async () => {
    const packageJson = JSON.parse(await readFile(join(full, "npm", "package.json"), "utf8"));
    expect(packageJson.name).toBe("@acme/share-upload");
    expect(packageJson.bin).toEqual({ "acme-share-upload": "dist/acme-share-upload.js" });
    expect(await Bun.file(join(full, "npm", "dist", "acme-share-upload.js")).exists()).toBe(true);
  });

  test("writes the client metadata document at the URL the bundle registers with", async () => {
    const document = JSON.parse(
      await readFile(join(full, "mcp-clients", "claude-code.json"), "utf8"),
    );
    expect(document.client_id).toBe("https://share.acme.example/mcp-clients/claude-code.json");
    expect(await Bun.file(join(bare, "mcp-clients", "claude-code.json")).exists()).toBe(false);
  });
});

describe("a generated server", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ name: "test", version: "0" });
    await client.connect(
      new StdioClientTransport({
        command: "node",
        args: [bundle(bare)],
        env: await cleanEnvironment(),
      }),
    );
  });

  afterAll(async () => {
    await client.close();
  });

  test("names itself and its tools after the company", async () => {
    expect(client.getServerVersion()?.name).toBe("acme-share-upload");
    const { tools } = await client.listTools();
    const text = JSON.stringify(tools);
    expect(text).toContain("Acme Share");
    expect(text).not.toContain("Portego");
  });

  test("tells a person with no deployment to run the company's package", async () => {
    await writeFile(join(directory, "page.html"), "<!doctype html><title>t</title>");
    const result = (await client.callTool({
      name: "upload_artifact_from_path",
      arguments: { path: join(directory, "page.html") },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("No Acme Share deployment");
    expect(result.content[0]?.text).toContain("npx -y @acme/share-upload auth <origin>");
  });
});

describe("a generated build with --origin and --style", () => {
  test("uses the company's deployment without asking for one", async () => {
    await writeFile(join(directory, "page.html"), "<!doctype html><title>t</title>");
    const { code, stderr } = await run(full, ["upload", join(directory, "page.html")]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("Not signed in to https://share.acme.example");
    expect(stderr).toContain("npx -y @acme/share-upload auth");
  });

  test("uses the company's style when the person selects none", async () => {
    const { code, stdout } = await run(full, ["style"]);
    expect(code).toBe(0);
    const summary = JSON.parse(stdout);
    expect(summary.name).toBe("Acme");
    expect(summary.source).toBe("bundled");
    // Extending the Portego style keeps its templates.
    expect(summary.templates.map((template: { name: string }) => template.name)).toContain(
      "report",
    );
  });

  test("names a finished file after the company", async () => {
    const draft = join(directory, "report.html");
    expect((await run(full, ["prepare", draft, "--title", "Q3"])).code).toBe(0);
    const finished = await run(full, ["finalize", draft]);
    expect(finished.stdout.trim()).toBe(join(directory, "report.acme-share.html"));
    const html = await readFile(join(directory, "report.acme-share.html"), "utf8");
    expect(html).not.toContain("Portego");
  });
});
