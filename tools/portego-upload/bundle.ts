/**
 * Bundles the tool and its dependencies into one file next to the bundled
 * artifact style. The npm package ships that directory, and the Claude Code
 * plugin starts the server from a copy of it.
 */
import { chmod, copyFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Brand } from "./brand.ts";

const repository = join(import.meta.dir, "..", "..");
const fonts = [
  ["ibm-plex-serif", "ibm-plex-serif-latin-400-normal.woff2"],
  ["ibm-plex-serif", "ibm-plex-serif-latin-500-normal.woff2"],
  ["ibm-plex-sans", "ibm-plex-sans-latin-400-normal.woff2"],
  ["ibm-plex-sans", "ibm-plex-sans-latin-600-normal.woff2"],
  ["ibm-plex-mono", "ibm-plex-mono-latin-400-normal.woff2"],
] as const;

// zod re-exports its error messages in every language as a namespace, which
// the bundler cannot drop. Nothing reads them; zod loads English on its own.
const englishOnlyZod: import("bun").BunPlugin = {
  name: "zod-locales-english-only",
  setup(build) {
    build.onLoad({ filter: /zod\/v4\/locales\/index\.js$/ }, () => ({
      contents: 'export { default as en } from "./en.js";',
      loader: "js",
    }));
  },
};

/**
 * Writes `<outdir>/<filename>` and `<outdir>/style/`, and returns the bundle's
 * path. Without `brand` the bundle uses the Portego names.
 */
export async function bundleTool(options: {
  outdir: string;
  filename: string;
  brand?: Brand;
}): Promise<string> {
  const stagedStyle = join(options.outdir, "style");
  await cp(join(import.meta.dir, "style"), stagedStyle, {
    recursive: true,
    filter: (path) => !path.includes(`${process.platform === "win32" ? "\\" : "/"}assets`),
  });
  const fontDirectory = join(stagedStyle, "portego", "assets", "fonts");
  await mkdir(fontDirectory, { recursive: true });
  for (const [family, filename] of fonts) {
    const source = join(repository, "node_modules", "@fontsource", family, "files", filename);
    await copyFile(source, join(fontDirectory, filename));
  }
  await copyFile(
    join(repository, "node_modules", "@fontsource", "ibm-plex-sans", "LICENSE"),
    join(fontDirectory, "LICENSE.txt"),
  );

  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "index.ts")],
    target: "node",
    outdir: options.outdir,
    naming: options.filename,
    minify: true,
    plugins: [englishOnlyZod],
    ...(options.brand ? { define: { PORTEGO_BRAND: JSON.stringify(options.brand) } } : {}),
  });
  if (!result.success) {
    throw new AggregateError(result.logs, "The upload tool did not bundle.");
  }

  // The bundle keeps the source's bun shebang, and npx has to start it with node.
  const path = join(options.outdir, options.filename);
  const bundle = await readFile(path, "utf8");
  await writeFile(path, bundle.replace(/^#!.*\n/, "#!/usr/bin/env node\n"));
  await chmod(path, 0o755);
  return path;
}
