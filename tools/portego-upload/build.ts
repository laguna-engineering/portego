/** Bundles the tool and its dependencies into the one file the npm package ships. */
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const outdir = join(import.meta.dir, "dist");
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
