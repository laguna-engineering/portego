import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app.ts";
import { createArtifactService } from "./artifacts/service.ts";
import { createTestAuth, TEST_BASE_URL } from "./auth/testing.ts";
import { createEventBus } from "./events/bus.ts";
import { createMarkdownStore } from "./markdown/store.ts";
import { createOrganizationService } from "./organization/service.ts";
import { createArtifactStore } from "./storage/artifacts.ts";
import { createCommentStore } from "./storage/comments.ts";
import { createOrganizationStore } from "./storage/organization.ts";
import { createTestServer, TEST_CONTENT_ORIGIN } from "./testing.ts";

const cleanups: (() => void)[] = [];

afterAll(() => {
  for (const cleanup of cleanups) cleanup();
});

/** These tests never reach the artifact routes, so nothing is written to disk. */
async function createTestApp(options?: { serveClient: boolean; clientDist: string }) {
  const { auth, config, database } = await createTestAuth();
  const events = createEventBus();
  const artifactStore = createArtifactStore({ database, dataDir: "data" });
  const organization = createOrganizationService({
    store: createOrganizationStore(database),
    artifactExists: (id) => artifactStore.get(id) !== null,
    events,
  });
  return createApp({
    serveClient: options?.serveClient ?? false,
    clientDist: options?.clientDist ?? "dist/client",
    auth,
    authConfig: config,
    artifacts: createArtifactService({
      store: artifactStore,
      markdownStore: createMarkdownStore({ database }),
      commentStore: createCommentStore({ database }),
      organization,
    }),
    organization,
    contentOrigin: TEST_CONTENT_ORIGIN,
    signingSecret: config.secret,
    events,
  });
}

async function signedInCookie() {
  const server = await createTestServer();
  cleanups.push(server.cleanup);
  return { app: server.app, cookie: await server.signIn() };
}

describe("GET /healthz", () => {
  test("reports the service as healthy", async () => {
    const app = await createTestApp();
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: "ok" });
  });

  test("leaks no secrets or database details, because the reverse proxy exposes it publicly", async () => {
    const app = await createTestApp();
    const body = await (await app.request("/healthz")).text();
    expect(body.toLowerCase()).not.toMatch(/secret|password|token|database|postgres|dsn|conn/);
  });
});

describe("GET /api/auth-providers", () => {
  test("lists the enabled providers so the sign-in page names none of them itself", async () => {
    const app = await createTestApp();
    const res = await app.request("/api/auth-providers");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ providers: [{ id: "google", label: "Google" }] });
  });

  test("stays readable without a session, since it is the sign-in page's first call", async () => {
    const app = await createTestApp();
    expect((await app.request("/api/auth-providers")).status).toBe(200);
  });

  test("carries no client credentials", async () => {
    const app = await createTestApp();
    const body = await (await app.request("/api/auth-providers")).text();
    expect(body).not.toContain("test-client-secret");
  });
});

describe("GET /api/me", () => {
  test("refuses an anonymous request", async () => {
    const app = await createTestApp();
    const res = await app.request("/api/me");
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "UNAUTHENTICATED" } });
  });

  test("returns the signed-in user", async () => {
    const { app, cookie } = await signedInCookie();
    const res = await app.request("/api/me", { headers: { cookie } });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      user: { email: "person@acme.example" },
      limits: { maxUploadBytes: 5 * 1024 * 1024 },
    });
  });
});

describe("cross-site request forgery", () => {
  test("refuses a cookie-authenticated write sent from another origin", async () => {
    const { app, cookie } = await signedInCookie();
    const res = await app.request("/api/auth/sign-out", {
      method: "POST",
      headers: { cookie, origin: "https://attacker.example" },
    });
    expect(res.status).toBe(403);
  });

  test("refuses a cookie-authenticated write with no origin header at all", async () => {
    const { app, cookie } = await signedInCookie();
    const res = await app.request("/api/auth/sign-out", { method: "POST", headers: { cookie } });
    expect(res.status).toBe(403);
  });

  test("allows a write from the application's own origin", async () => {
    const { app, cookie } = await signedInCookie();
    const res = await app.request("/api/auth/sign-out", {
      method: "POST",
      headers: { cookie, origin: TEST_BASE_URL },
    });
    expect(res.status).toBe(200);
  });
});

describe("client routes", () => {
  test("does not answer unknown paths when the client is served by Vite", async () => {
    const app = await createTestApp();
    expect((await app.request("/nope")).status).toBe(404);
  });

  test("keeps unknown API paths a 404 when the client is served from disk", async () => {
    // With a built client present the catch-all would otherwise answer /api/nope
    // with index.html, and the client would try to parse HTML as JSON.
    const cwd = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), "client-"));
    mkdirSync(join(dir, "dist/client"), { recursive: true });
    writeFileSync(join(dir, "dist/client/index.html"), "<!doctype html><title>Portego</title>");
    process.chdir(dir);

    try {
      const prod = await createTestApp({ serveClient: true, clientDist: "dist/client" });
      expect((await prod.request("/")).status).toBe(200);
      expect((await prod.request("/deep/link")).status).toBe(200);
      expect((await prod.request("/api/nope")).status).toBe(404);
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("answers a missing hashed asset with 404 instead of index.html", async () => {
    // A stale index.html after a deploy can name an asset the new build removed.
    // The catch-all would answer it with HTML and status 200, and the browser
    // would fail parsing that as JavaScript.
    const cwd = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), "client-"));
    mkdirSync(join(dir, "dist/client/assets"), { recursive: true });
    writeFileSync(join(dir, "dist/client/index.html"), "<!doctype html><title>Portego</title>");
    writeFileSync(join(dir, "dist/client/assets/index-abc123.js"), "export const ok = true;\n");
    process.chdir(dir);

    try {
      const prod = await createTestApp({ serveClient: true, clientDist: "dist/client" });

      const found = await prod.request("/assets/index-abc123.js");
      expect(found.status).toBe(200);
      expect(found.headers.get("content-type")).toMatch(/javascript/);

      const missing = await prod.request("/assets/index-removed.js");
      expect(missing.status).toBe(404);
      expect(missing.headers.get("content-type")).not.toMatch(/html/);
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
