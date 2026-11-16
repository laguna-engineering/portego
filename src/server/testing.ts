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
import { loadBranding } from "./branding.ts";
import { databasePath, openDatabase } from "./db.ts";
import { createEventBus, type EventBus } from "./events/bus.ts";
import { createMarkdownStore } from "./markdown/store.ts";
import { createOrganizationService, type OrganizationService } from "./organization/service.ts";
import {
  createServiceAccountService,
  type ServiceAccountService,
} from "./service-accounts/service.ts";
import { createActivityStore } from "./storage/activity.ts";
import { createArtifactStore } from "./storage/artifacts.ts";
import { createCommentStore } from "./storage/comments.ts";
import { createEntryStore } from "./storage/entries.ts";
import { applyMigrations } from "./storage/migrations.ts";
import { createOrganizationStore } from "./storage/organization.ts";
import { createProfileStore } from "./storage/profiles.ts";
import { createSearchStore } from "./storage/search.ts";
import { createServiceAccountStore } from "./storage/service-accounts.ts";
import { createVardaOutbox, type VardaOutbox } from "./storage/varda-outbox.ts";
import { createTeams, type TeamService } from "./teams/service.ts";

/** A different host from TEST_BASE_URL, which is what isolates a preview. */
export const TEST_CONTENT_ORIGIN = "http://127.0.0.1:5173";

export const WORKSPACE_USER: TestClaims = {
  sub: "google-subject-1",
  email: "person@acme.example",
  email_verified: true,
  name: "A Person",
};

/** Varda's account in a test server with the Varda integration on. */
export const VARDA_USER: TestClaims = {
  sub: "google-subject-varda",
  email: "varda@acme.example",
  email_verified: true,
  name: "Varda",
};

export type TestServer = {
  app: Hono<AppEnv>;
  auth: Auth;
  database: Database;
  artifacts: ArtifactService;
  organization: OrganizationService;
  events: EventBus;
  /** Null unless the test turned service accounts on. */
  serviceAccounts: ServiceAccountService | null;
  /** Null unless the test turned teams on. */
  teams: TeamService | null;
  vardaOutbox: VardaOutbox;
  /** The user id of VARDA_USER, when the Varda integration is on. */
  vardaAccount?: string;
  dataDir: string;
  signingSecret: string;
  baseURL: string;
  /** Signs in and returns the cookie header for later requests. */
  signIn: (claims?: TestClaims) => Promise<string>;
  cleanup: () => void;
};

export type TestServerOptions = {
  maxUploadBytes?: number;
  privateArtifacts?: boolean;
  publicLinks?: boolean;
  /** The origin the app answers on. A live server passes its own. */
  baseURL?: string;
  contentOrigin?: string;
  providers?: ResolvedProvider[];
  /** Serve the built client from disk, which the browser tests need. */
  serveClient?: boolean;
  serviceAccounts?: boolean;
  teams?: boolean;
  admins?: string[];
  /** Admit every authenticated identity instead of the test domain. */
  allowAll?: boolean;
  /** The clock service accounts and invitations read, in epoch ms. */
  now?: () => number;
  /** Turns the Varda integration on, with VARDA_USER as Varda's account. */
  varda?: { webhookSecret?: string; now?: () => number };
};

export async function createTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  const dataDir = await mkdtemp(join(tmpdir(), "server-"));
  const database = openDatabase(databasePath(dataDir));
  const { auth, config } = await createTestAuth({
    database,
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    ...(options.providers ? { providers: options.providers } : {}),
    ...(options.admins ? { admins: options.admins } : {}),
    ...(options.serviceAccounts ? { serviceAccounts: true } : {}),
    ...(options.teams ? { teams: true } : {}),
    ...(options.allowAll ? { allowAll: true } : {}),
  });
  applyMigrations(database);
  // User ids are made at sign-in, so Varda's account signs in before the
  // service that needs its id exists.
  let vardaAccount: string | undefined;
  if (options.varda) {
    await signIn(auth, VARDA_USER);
    const user = database
      .query('select id from "user" where email = ?')
      .get(VARDA_USER.email ?? "") as { id: string } | null;
    if (!user) throw new Error("Varda's test account did not sign in");
    vardaAccount = user.id;
  }
  const vardaOutbox = createVardaOutbox({ database });

  const events = createEventBus();
  const {
    access,
    teams,
    store: teamStore,
  } = createTeams(database, {
    enabled: config.teams,
    events,
    ...(options.now ? { now: options.now } : {}),
  });
  const artifactStore = createArtifactStore({ database, dataDir });
  const organization = createOrganizationService({
    store: createOrganizationStore(database),
    artifactExists: (id) => artifactStore.get(id) !== null,
    events,
    access,
  });
  const artifacts = createArtifactService({
    store: artifactStore,
    markdownStore: createMarkdownStore({ database }),
    commentStore: createCommentStore({ database }),
    entryStore: createEntryStore({ database, outbox: vardaOutbox }),
    searchStore: createSearchStore({ database }),
    organization,
    events,
    ...(vardaAccount === undefined
      ? {}
      : { varda: { account: vardaAccount, outbox: vardaOutbox } }),
    ...(options.maxUploadBytes ? { maxUploadBytes: options.maxUploadBytes } : {}),
    ...(options.privateArtifacts === undefined
      ? {}
      : { privateArtifacts: options.privateArtifacts }),
    ...(options.publicLinks === undefined ? {} : { publicLinks: options.publicLinks }),
    access,
  });

  const serviceAccounts = config.serviceAccounts
    ? createServiceAccountService({
        store: createServiceAccountStore(database),
        baseURL: config.baseURL,
        mcpResource: config.mcp.resource,
        teams: teamStore,
        ...(options.now ? { now: options.now } : {}),
      })
    : null;

  const app = createApp({
    serveClient: options.serveClient ?? false,
    clientDist: "dist/client",
    branding: loadBranding(undefined, "dist/client"),
    auth,
    authConfig: config,
    artifacts,
    organization,
    contentOrigin: options.contentOrigin ?? TEST_CONTENT_ORIGIN,
    signingSecret: config.secret,
    events,
    activity: createActivityStore({ database }),
    profiles: createProfileStore({ database }),
    serviceAccounts,
    access,
    teams,
    ...(vardaAccount === undefined
      ? {}
      : {
          varda: {
            account: vardaAccount,
            outbox: vardaOutbox,
            ...(options.varda?.webhookSecret ? { webhookSecret: options.varda.webhookSecret } : {}),
            ...(options.varda?.now ? { now: options.varda.now } : {}),
          },
        }),
  });

  return {
    app,
    auth,
    database,
    artifacts,
    organization,
    events,
    serviceAccounts,
    teams,
    vardaOutbox,
    ...(vardaAccount === undefined ? {} : { vardaAccount }),
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
  options: {
    serveClient?: boolean;
    idleTimeout?: number;
    privateArtifacts?: boolean;
    publicLinks?: boolean;
    serviceAccounts?: boolean;
    teams?: boolean;
    admins?: string[];
    now?: () => number;
    varda?: TestServerOptions["varda"];
  } = {},
): Promise<LiveTestServer> {
  let handle: TestServer | null = null;
  const listener = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    ...(options.idleTimeout === undefined ? {} : { idleTimeout: options.idleTimeout }),
    // The server goes along as the environment, as it does in production.
    fetch: (request, server) =>
      handle ? handle.app.fetch(request, server) : new Response("not ready", { status: 503 }),
  });

  const origin = `http://127.0.0.1:${listener.port}`;
  const server = await createTestServer({
    baseURL: origin,
    // A different host on the same listener, which is what isolates previews.
    contentOrigin: `http://localhost:${listener.port}`,
    ...(options.serveClient ? { serveClient: true } : {}),
    ...(options.privateArtifacts === undefined
      ? {}
      : { privateArtifacts: options.privateArtifacts }),
    ...(options.publicLinks === undefined ? {} : { publicLinks: options.publicLinks }),
    ...(options.serviceAccounts ? { serviceAccounts: true } : {}),
    ...(options.teams ? { teams: true } : {}),
    ...(options.admins ? { admins: options.admins } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.varda ? { varda: options.varda } : {}),
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
