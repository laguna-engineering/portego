/** Test support for the whole server: one temporary directory and database. */

import type { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { createApp } from "./app.ts";
import { type ArtifactService, createArtifactService } from "./artifacts/service.ts";
import type { Auth } from "./auth/auth.ts";
import type { AppEnv } from "./auth/middleware.ts";
import type { ResolvedProvider } from "./auth/providers/index.ts";
import { createTestAuth, signIn, type TestClaims } from "./auth/testing.ts";
import { databasePath, openDatabase } from "./db.ts";
import { createEventBus, type EventBus } from "./events/bus.ts";
import { createMarkdownStore } from "./markdown/store.ts";
import { createArtifactStore } from "./storage/artifacts.ts";
import { createCommentStore } from "./storage/comments.ts";
import { applyMigrations } from "./storage/migrations.ts";

/** A different host from TEST_BASE_URL, which is what isolates a preview. */
export const TEST_CONTENT_ORIGIN = "http://127.0.0.1:5173";

export const WORKSPACE_USER: TestClaims = {
  sub: "google-subject-1",
  email: "person@acme.example",
  email_verified: true,
  name: "A Person",
};

export type TestServer = {
  app: Hono<AppEnv>;
  auth: Auth;
  database: Database;
  artifacts: ArtifactService;
  events: EventBus;
  dataDir: string;
  signingSecret: string;
  baseURL: string;
  /** Signs in and returns the cookie header for later requests. */
  signIn: (claims?: TestClaims) => Promise<string>;
  cleanup: () => void;
};

export type TestServerOptions = {
  maxUploadBytes?: number;
  /** The origin the app answers on. A live server passes its own. */
  baseURL?: string;
  contentOrigin?: string;
  providers?: ResolvedProvider[];
  /** Serve the built client from disk, which the browser tests need. */
  serveClient?: boolean;
};

export async function createTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  const dataDir = await mkdtemp(join(tmpdir(), "server-"));
  const database = openDatabase(databasePath(dataDir));
  const { auth, config } = await createTestAuth({
    database,
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    ...(options.providers ? { providers: options.providers } : {}),
  });
  applyMigrations(database);

  const events = createEventBus();
  const artifacts = createArtifactService({
    store: createArtifactStore({ database, dataDir }),
    markdownStore: createMarkdownStore({ database }),
    commentStore: createCommentStore({ database }),
    events,
    ...(options.maxUploadBytes ? { maxUploadBytes: options.maxUploadBytes } : {}),
  });

  const app = createApp({
    serveClient: options.serveClient ?? false,
    clientDist: "dist/client",
    auth,
    authConfig: config,
    artifacts,
    contentOrigin: options.contentOrigin ?? TEST_CONTENT_ORIGIN,
    signingSecret: config.secret,
    events,
  });

  return {
    app,
    auth,
    database,
    artifacts,
    events,
    dataDir,
    signingSecret: config.secret,
    baseURL: config.baseURL,
    async signIn(claims = WORKSPACE_USER) {
      const res = await signIn(auth, claims);
      const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      if (cookie === "") throw new Error("Sign-in returned no session cookie");
      return cookie;
    },
    cleanup() {
      database.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export function htmlFile(body: string, name = "artifact.html"): File {
  return new File([`<!doctype html><html><title>Doc</title>${body}</html>`], name, {
    type: "text/html",
  });
}

export type LiveTestServer = TestServer & {
  origin: string;
  contentOrigin: string;
  stop: () => void;
};

/**
 * A test server on a real port. The MCP endpoint verifies access tokens
 * against the JWKS it publishes over HTTP, so that flow needs a listener
 * rather than an in-process request.
 */
export async function createLiveTestServer(
  options: { serveClient?: boolean } = {},
): Promise<LiveTestServer> {
  let handle: TestServer | null = null;
  const listener = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) =>
      handle ? handle.app.fetch(request) : new Response("not ready", { status: 503 }),
  });

  const origin = `http://127.0.0.1:${listener.port}`;
  const server = await createTestServer({
    baseURL: origin,
    // A different host on the same listener, which is what isolates previews.
    contentOrigin: `http://localhost:${listener.port}`,
    ...(options.serveClient ? { serveClient: true } : {}),
  });
  handle = server;

  return {
    ...server,
    origin,
    contentOrigin: `http://localhost:${listener.port}`,
    stop() {
      listener.stop(true);
      server.cleanup();
    },
    cleanup() {
      listener.stop(true);
      server.cleanup();
    },
  };
}
