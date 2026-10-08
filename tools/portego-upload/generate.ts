/**
 * Builds a renamed copy of the upload tool for one company: a Claude Code
 * marketplace holding the plugin, an npm package, and, with --origin, the
 * client metadata document the deployment serves. docs/custom-plugin.md
 * describes the options and the output.
 *
 *   bun run generate:upload-tool --name "Acme Share" --slug acme-share \
 *     --package @acme/share-upload --origin https://share.acme.example \
 *     --style ./acme-style --out ../acme-share-upload
 */
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Brand } from "./brand.ts";
import { bundleTool } from "./bundle.ts";
import { resolveArtifactStyle } from "./style.ts";

const repository = join(import.meta.dir, "..", "..");
const sourcePlugin = join(repository, "plugins", "portego-upload");

export type GenerateOptions = Brand & {
  /** A style directory to bundle as the default in place of the Portego one. */
  style?: string;
  /** Must not exist yet, or be empty. */
  out: string;
};

export class GenerateError extends Error {}

/**
 * Product names in prose change. The lowercase identifiers next to them,
 * window.portego, the portego: events, and the data-portego- markers, are
 * the page API and stay.
 */
export function renameProse(text: string, brand: Brand): string {
  return text
    .replaceAll("npx -y portego-upload", `npx -y ${brand.packageName}`)
    .replace(/\bPortego\b/g, brand.name);
}

export function validateOptions(options: GenerateOptions): GenerateOptions {
  const errors: string[] = [];
  if (!options.name.trim() || /[\n\r]/.test(options.name) || options.name.length > 60) {
    errors.push("--name must be one line of at most 60 characters");
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.slug)) {
    errors.push("--slug must be lowercase letters and digits joined by single hyphens");
  }
  if (!/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(options.packageName)) {
    errors.push("--package must be a valid npm package name");
  }
  let origin: string | undefined;
  if (options.origin !== undefined) {
    try {
      const url = new URL(options.origin);
      if (url.protocol !== "https:") throw new Error();
      origin = url.origin;
    } catch {
      errors.push("--origin must be an https URL");
    }
  }
  if (errors.length > 0) throw new GenerateError(errors.join("\n"));
  return { ...options, name: options.name.trim(), ...(origin ? { origin } : {}) };
}

async function assertEmpty(directory: string): Promise<void> {
  const entries = await readdir(directory).catch(() => []);
  if (entries.length > 0) {
    throw new GenerateError(`${directory} is not empty. Choose a new --out directory.`);
  }
}

async function renameFiles(directory: string, brand: Brand, pattern: RegExp): Promise<void> {
  for (const entry of await readdir(directory, { recursive: true })) {
    if (!pattern.test(entry)) continue;
    const path = join(directory, entry);
    await writeFile(path, renameProse(await readFile(path, "utf8"), brand));
  }
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Returns the paths it wrote, relative to `out`. */
export async function generate(input: GenerateOptions): Promise<string[]> {
  const options = validateOptions(input);
  const brand: Brand = {
    name: options.name,
    slug: options.slug,
    packageName: options.packageName,
    ...(options.origin ? { origin: options.origin } : {}),
  };
  const out = resolve(options.out);
  await assertEmpty(out);
  if (options.style) {
    // Refuses a style that would fail on a person's machine.
    await resolveArtifactStyle({ stylePath: resolve(options.style) });
  }

  const command = `${brand.slug}-upload`;
  const bundleFile = `${command}.js`;
  const { version, license, description, engines } = await readJson(
    join(import.meta.dir, "package.json"),
  );

  const npm = join(out, "npm");
  const dist = join(npm, "dist");
  await bundleTool({ outdir: dist, filename: bundleFile, brand });
  await renameFiles(join(dist, "style", "portego"), brand, /\.(md|html|json)$/);
  if (options.style) {
    await cp(resolve(options.style), join(dist, "style", "default"), { recursive: true });
  }
  await writeJson(join(npm, "package.json"), {
    name: brand.packageName,
    version,
    description: renameProse(String(description), brand),
    license,
    type: "module",
    bin: { [command]: `dist/${bundleFile}` },
    files: ["dist"],
    engines,
  });

  const plugin = join(out, "plugins", command);
  await cp(join(sourcePlugin, "skills"), join(plugin, "skills"), { recursive: true });
  await renameFiles(join(plugin, "skills"), brand, /\.md$/);
  await cp(dist, join(plugin, "server"), { recursive: true });

  const manifest = JSON.parse(
    renameProse(await readFile(join(sourcePlugin, ".claude-plugin", "plugin.json"), "utf8"), brand),
  );
  if (brand.origin) {
    manifest.userConfig.origin.description = `The address of your deployment. Leave it empty to use ${brand.origin}.`;
  }
  const server = manifest.mcpServers["portego-upload"];
  server.args = [`\${CLAUDE_PLUGIN_ROOT}/server/${bundleFile}`];
  await mkdir(join(plugin, ".claude-plugin"), { recursive: true });
  await writeJson(join(plugin, ".claude-plugin", "plugin.json"), {
    ...manifest,
    name: command,
    version,
    mcpServers: { [command]: server },
  });

  await mkdir(join(out, ".claude-plugin"), { recursive: true });
  await writeJson(join(out, ".claude-plugin", "marketplace.json"), {
    name: brand.slug,
    owner: { name: brand.name },
    plugins: [{ name: command, source: `./plugins/${command}`, description: manifest.description }],
  });

  if (brand.origin) {
    const document = await readJson(join(import.meta.dir, "claude-code.json"));
    await mkdir(join(out, "mcp-clients"), { recursive: true });
    await writeJson(join(out, "mcp-clients", "claude-code.json"), {
      ...document,
      client_id: `${brand.origin}/mcp-clients/claude-code.json`,
    });
  }

  return (await readdir(out, { recursive: true })).sort();
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      name: { type: "string" },
      slug: { type: "string" },
      package: { type: "string" },
      origin: { type: "string" },
      style: { type: "string" },
      out: { type: "string" },
    },
  });
  if (!values.name || !values.slug || !values.out) {
    console.error(
      "Usage: bun run generate:upload-tool --name <name> --slug <slug> --out <directory>\n" +
        "         [--package <npm name>] [--origin <https URL>] [--style <directory>]",
    );
    process.exit(2);
  }
  try {
    await generate({
      name: values.name,
      slug: values.slug,
      packageName: values.package ?? `${values.slug}-upload`,
      ...(values.origin ? { origin: values.origin } : {}),
      ...(values.style ? { style: values.style } : {}),
      out: values.out,
    });
    console.log(`Wrote ${resolve(values.out)}. docs/custom-plugin.md lists the next steps.`);
  } catch (error) {
    if (!(error instanceof GenerateError)) throw error;
    console.error(error.message);
    process.exit(1);
  }
}
