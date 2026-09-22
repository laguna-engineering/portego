/** Bundles the tool and its dependencies into the one file the npm package ships. */
import { chmod, copyFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
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

const result = await Bun.build({
  entrypoints: [join(import.meta.dir, "index.ts")],
  target: "node",
  outdir,
  naming: "portego-upload.js",
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
