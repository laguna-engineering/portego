import { createApp } from "./app.ts";
import { MULTIPART_OVERHEAD_BYTES } from "./artifacts/routes.ts";
import { createArtifactService } from "./artifacts/service.ts";
import { createAuth } from "./auth/auth.ts";
import { parseAuthConfig } from "./auth/config.ts";
import { databasePath, openDatabase } from "./db.ts";
import { parseEnv } from "./env.ts";
import { createEventBus } from "./events/bus.ts";
import { createMarkdownStore } from "./markdown/store.ts";
import { createArtifactStore } from "./storage/artifacts.ts";
import { createCommentStore } from "./storage/comments.ts";

const env = parseEnv(Bun.env);
const authConfig = parseAuthConfig(env, Bun.env);
const database = openDatabase(databasePath(env.DATA_DIR));
const auth = createAuth({ config: authConfig, database });
const events = createEventBus();
const artifacts = createArtifactService({
  store: createArtifactStore({ database, dataDir: env.DATA_DIR }),
  markdownStore: createMarkdownStore({ database }),
  commentStore: createCommentStore({ database }),
  maxUploadBytes: env.ARTIFACT_MAX_BYTES,
  events,
});

const app = createApp({
  serveClient: env.NODE_ENV === "production",
  clientDist: env.CLIENT_DIST,
  auth,
  authConfig,
  artifacts,
  contentOrigin: env.CONTENT_URL,
  signingSecret: authConfig.secret,
  events,
});

const server = Bun.serve({
  hostname: env.HOST,
  port: env.PORT,
  // Refuse an oversize body before it is read, rather than buffering it and
  // rejecting it afterwards.
  maxRequestBodySize: env.ARTIFACT_MAX_BYTES + MULTIPART_OVERHEAD_BYTES,
  fetch: app.fetch,
});

console.log(`Server listening on http://${server.hostname}:${server.port}`);
