import { createApp } from "./app.ts";
import { maxUploadRequestBytes } from "./artifacts/routes.ts";
import { createArtifactService } from "./artifacts/service.ts";
import { createAuth } from "./auth/auth.ts";
import { parseAuthConfig } from "./auth/config.ts";
import { loadBranding } from "./branding.ts";
import { databasePath, openDatabase } from "./db.ts";
import { parseEnv } from "./env.ts";
import { createEventBus } from "./events/bus.ts";
import { createMarkdownStore } from "./markdown/store.ts";
import { createOrganizationService } from "./organization/service.ts";
import { createActivityStore } from "./storage/activity.ts";
import { createArtifactStore } from "./storage/artifacts.ts";
import { createCommentStore } from "./storage/comments.ts";
import { createEntryStore } from "./storage/entries.ts";
import { createOrganizationStore } from "./storage/organization.ts";
import { createProfileStore } from "./storage/profiles.ts";

const env = parseEnv(Bun.env);
const authConfig = parseAuthConfig(env, Bun.env);
const database = openDatabase(databasePath(env.DATA_DIR));
const auth = createAuth({ config: authConfig, database });
const events = createEventBus();
const artifactStore = createArtifactStore({ database, dataDir: env.DATA_DIR });
const organization = createOrganizationService({
  store: createOrganizationStore(database),
  artifactExists: (id) => artifactStore.get(id) !== null,
  events,
});
const artifacts = createArtifactService({
  store: artifactStore,
  markdownStore: createMarkdownStore({ database }),
  commentStore: createCommentStore({ database }),
  entryStore: createEntryStore({ database }),
  organization,
  maxUploadBytes: env.ARTIFACT_MAX_BYTES,
  maxImages: env.ARTIFACT_MAX_IMAGES,
  maxImageBytesTotal: env.ARTIFACT_IMAGES_MAX_BYTES,
  privateArtifacts: env.PRIVATE_ARTIFACTS,
  events,
});

const app = createApp({
  serveClient: env.NODE_ENV === "production",
  clientDist: env.CLIENT_DIST,
  branding: loadBranding(env.BRANDING_DIR, env.CLIENT_DIST),
  auth,
  authConfig,
  artifacts,
  organization,
  contentOrigin: env.CONTENT_URL,
  signingSecret: authConfig.secret,
  events,
  activity: createActivityStore({ database }),
  profiles: createProfileStore({ database }),
});

const server = Bun.serve({
  hostname: env.HOST,
  port: env.PORT,
  // Refuse an oversize body before it is read, rather than buffering it and
  // rejecting it afterwards.
  maxRequestBodySize: maxUploadRequestBytes(artifacts),
  fetch: app.fetch,
});

console.log(`Server listening on http://${server.hostname}:${server.port}`);
