/**
 * Builds the npm package's dist/ and copies it into the Claude Code plugin,
 * which starts the server from its own directory instead of fetching the
 * package.
 */
import { copyFile, cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { bundleTool } from "./bundle.ts";

const outdir = join(import.meta.dir, "dist");
const path = await bundleTool({ outdir, filename: "portego-upload.js" });

const pluginServer = join(import.meta.dir, "..", "..", "plugins", "portego-upload", "server");
await rm(pluginServer, { recursive: true, force: true });
await mkdir(pluginServer, { recursive: true });
await copyFile(path, join(pluginServer, "portego-upload.js"));
await cp(join(outdir, "style"), join(pluginServer, "style"), { recursive: true });
