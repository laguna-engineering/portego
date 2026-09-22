/**
 * Bundles the tool and its dependencies into the one file the npm package
 * ships, and copies that build into the Claude Code plugin, which starts the
 * server from its own directory instead of fetching the package.
 */
import { chmod, copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const outdir = join(import.meta.dir, "dist");
const styleSource = join(import.meta.dir, "style");
const stagedStyle = join(outdir, "style");
const fonts = [
  ["ibm-plex-serif", "ibm-plex-serif-latin-400-normal.woff2"],
  ["ibm-plex-serif", "ibm-plex-serif-latin-500-normal.woff2"],
  ["ibm-plex-sans", "ibm-plex-sans-latin-400-normal.woff2"],
  ["ibm-plex-sans", "ibm-plex-sans-latin-600-normal.woff2"],
  ["ibm-plex-mono", "ibm-plex-mono-latin-400-normal.woff2"],
] as const;

await cp(styleSource, stagedStyle, {
  recursive: true,
  filter: (path) => !path.includes(`${process.platform === "win32" ? "\\" : "/"}assets`),
});
const fontDirectory = join(stagedStyle, "portego", "assets", "fonts");
await mkdir(fontDirectory, { recursive: true });
for (const [family, filename] of fonts) {
  const source = join(
    import.meta.dir,
    "..",
    "..",
    "node_modules",
    "@fontsource",
    family,
    "files",
    filename,
  );
  await copyFile(source, join(fontDirectory, filename));
}
await copyFile(
  join(import.meta.dir, "..", "..", "node_modules", "@fontsource", "ibm-plex-sans", "LICENSE"),
  join(fontDirectory, "LICENSE.txt"),
);

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

const result = await Bun.build({
  entrypoints: [join(import.meta.dir, "index.ts")],
  target: "node",
  outdir,
  naming: "portego-upload.js",
  minify: true,
  plugins: [englishOnlyZod],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// The bundle keeps the source's bun shebang, and npx has to start it with node.
const path = join(outdir, "portego-upload.js");
const bundle = await readFile(path, "utf8");
await writeFile(path, bundle.replace(/^#!.*\n/, "#!/usr/bin/env node\n"));
await chmod(path, 0o755);

const pluginServer = join(import.meta.dir, "..", "..", "plugins", "portego-upload", "server");
await rm(pluginServer, { recursive: true, force: true });
await mkdir(pluginServer, { recursive: true });
await copyFile(path, join(pluginServer, "portego-upload.js"));
await cp(stagedStyle, join(pluginServer, "style"), { recursive: true });
