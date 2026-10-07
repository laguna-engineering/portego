import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app.ts";
import { createArtifactService } from "./artifacts/service.ts";
import { createTestAuth, TEST_BASE_URL } from "./auth/testing.ts";
import { loadBranding } from "./branding.ts";
import { createEventBus } from "./events/bus.ts";
import { createMarkdownStore } from "./markdown/store.ts";
import { createOrganizationService } from "./organization/service.ts";
import { excerpt } from "./social.ts";
import { createActivityStore } from "./storage/activity.ts";
import { createArtifactStore } from "./storage/artifacts.ts";
import { createCommentStore } from "./storage/comments.ts";
import { createEntryStore } from "./storage/entries.ts";
import { createOrganizationStore } from "./storage/organization.ts";
import { createProfileStore } from "./storage/profiles.ts";
import { createTestServer, htmlFile, TEST_CONTENT_ORIGIN, WORKSPACE_USER } from "./testing.ts";

const cleanups: (() => void)[] = [];

afterAll(() => {
  for (const cleanup of cleanups) cleanup();
});

/** These tests never reach the artifact routes, so nothing is written to disk. */
async function createTestApp(options?: {
  serveClient: boolean;
  clientDist: string;
  brandingDir?: string;
}) {
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
    branding: loadBranding(options?.brandingDir, options?.clientDist ?? "dist/client"),
    auth,
    authConfig: config,
    artifacts: createArtifactService({
      store: artifactStore,
      markdownStore: createMarkdownStore({ database }),
      commentStore: createCommentStore({ database }),
      entryStore: createEntryStore({ database }),
      organization,
    }),
    organization,
    contentOrigin: TEST_CONTENT_ORIGIN,
    signingSecret: config.secret,
    events,
    activity: createActivityStore({ database }),
    profiles: createProfileStore({ database }),
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

  test("returns the signed-in user and the deployment's name for the folder root", async () => {
    const { app, cookie } = await signedInCookie();
    const res = await app.request("/api/me", { headers: { cookie } });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      user: { email: "person@acme.example" },
      limits: { maxUploadBytes: 5 * 1024 * 1024 },
      appName: "Test App",
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

  test("serves a deployment's branding over the defaults and names the page after it", async () => {
    const cwd = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), "client-"));
    mkdirSync(join(dir, "dist/client/branding"), { recursive: true });
    mkdirSync(join(dir, "brand"));
    writeFileSync(
      join(dir, "dist/client/index.html"),
      "<!doctype html><head><title>Portego</title></head>",
    );
    writeFileSync(join(dir, "dist/client/branding/logo-full.png"), "default-full");
    writeFileSync(join(dir, "dist/client/branding/logo-mark.png"), "default-mark");
    writeFileSync(join(dir, "brand/logo-mark.png"), "acme-mark");
    writeFileSync(join(dir, "brand/brand.css"), ":root { --accent: red; }");
    process.chdir(dir);

    try {
      const prod = await createTestApp({
        serveClient: true,
        clientDist: "dist/client",
        brandingDir: "brand",
      });

      const mark = await prod.request("/branding/logo-mark.png");
      expect(await mark.text()).toBe("acme-mark");
      expect(mark.headers.get("cache-control")).toBe("no-cache");
      // A browser holding the current copy gets an empty answer.
      const etag = mark.headers.get("etag") ?? "";
      const revalidated = await prod.request("/branding/logo-mark.png", {
        headers: { "If-None-Match": etag },
      });
      expect(revalidated.status).toBe(304);
      expect(await revalidated.text()).toBe("");

      expect(await (await prod.request("/branding/logo-full.png")).text()).toBe("default-full");
      const css = await prod.request("/branding/brand.css");
      expect(css.headers.get("content-type")).toMatch(/css/);

      // A missing or unknown file must not come back as index.html.
      for (const path of ["/branding/favicon-32.png", "/branding/other.png", "/branding/a/b"]) {
        const res = await prod.request(path);
        expect(res.status).toBe(404);
        expect(res.headers.get("content-type")).not.toMatch(/html/);
      }

      const page = await (await prod.request("/")).text();
      expect(page).toContain("<title>Test App</title>");
      expect(page).toContain('<link rel="stylesheet" href="/branding/brand.css" />');
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reads index.html once at startup, and refuses to start without it", async () => {
    const cwd = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), "client-"));
    mkdirSync(join(dir, "dist/client"), { recursive: true });
    process.chdir(dir);

    try {
      // Every route would answer 404, which looks like a running server.
      await expect(createTestApp({ serveClient: true, clientDist: "dist/client" })).rejects.toThrow(
        /index\.html/,
      );

      writeFileSync(join(dir, "dist/client/index.html"), "<head><title>First</title></head>");
      const prod = await createTestApp({ serveClient: true, clientDist: "dist/client" });
      writeFileSync(join(dir, "dist/client/index.html"), "<head><title>Second</title></head>");
      expect(await (await prod.request("/")).text()).toContain("<title>Test App</title>");
      expect(await (await prod.request("/")).text()).not.toContain("Second");
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("GET * (social tags)", () => {
  const cwd = process.cwd();
  let dir: string;

  const FIXTURE = [
    "<!doctype html>",
    "<html>",
    "<head>",
    "<title>Portego</title>",
    '<meta property="og:image" content="/assets/logo-full-abc.png" />',
    "</head>",
    "<body></body>",
    "</html>",
  ].join("\n");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "client-"));
    mkdirSync(join(dir, "dist/client"), { recursive: true });
    writeFileSync(join(dir, "dist/client/index.html"), FIXTURE);
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  });

  function uploadArtifact(
    server: Awaited<ReturnType<typeof createTestServer>>,
    cookie: string,
    fields: { title?: string; description?: string; html?: string } = {},
  ) {
    const form = new FormData();
    form.set("file", htmlFile(fields.html ?? "<p>x</p>", "artifact.html"));
    form.set("title", fields.title ?? "An artifact");
    if (fields.description !== undefined) form.set("description", fields.description);
    return server.app.request("/api/artifacts", {
      method: "POST",
      headers: { cookie, origin: TEST_BASE_URL },
      body: form,
    });
  }

  test("rewrites the root-relative og:image to an absolute URL on the app origin", async () => {
    const server = await createTestServer({ serveClient: true });
    try {
      const res = await server.app.request("/a/does-not-exist");
      const body = await res.text();
      expect(body).toContain(
        '<meta property="og:image" content="http://localhost:5173/assets/logo-full-abc.png" />',
      );
    } finally {
      server.cleanup();
    }
  });

  test("sets cache headers so a page carrying a cookie-dependent description is never shared across sessions", async () => {
    const server = await createTestServer({ serveClient: true });
    try {
      const res = await server.app.request("/a/does-not-exist");
      expect(res.headers.get("cache-control")).toBe("private, no-cache");
      expect(res.headers.get("vary")).toBe("Cookie");
    } finally {
      server.cleanup();
    }
  });

  test("lets frames load previews only, so an artifact cannot navigate its frame to another site", async () => {
    const server = await createTestServer({ serveClient: true });
    try {
      const res = await server.app.request("/a/does-not-exist");
      expect(res.headers.get("content-security-policy")).toBe(`frame-src ${TEST_CONTENT_ORIGIN}`);
    } finally {
      server.cleanup();
    }
  });

  test("falls back to the generic tags for an unknown artifact id", async () => {
    const server = await createTestServer({ serveClient: true });
    try {
      const res = await server.app.request("/a/does-not-exist");
      const body = await res.text();
      expect(body).toContain('<meta property="og:title" content="Test App" />');
      expect(body).toContain("<title>Test App</title>");
      expect(body).not.toContain('name="description"');
      expect(body).not.toContain("og:description");
    } finally {
      server.cleanup();
    }
  });

  test("falls back to the generic tags for an archived artifact, even for its own creator", async () => {
    const server = await createTestServer({ serveClient: true });
    try {
      const cookie = await server.signIn();
      const upload = await uploadArtifact(server, cookie, { title: "Retired plan" });
      const { artifact } = (await upload.json()) as { artifact: { id: string } };

      const archive = await server.app.request(`/api/artifacts/${artifact.id}/archived`, {
        method: "PATCH",
        headers: { cookie, origin: TEST_BASE_URL, "content-type": "application/json" },
        body: JSON.stringify({ archived: true }),
      });
      expect(archive.status).toBe(200);

      const res = await server.app.request(`/a/${artifact.id}`, { headers: { cookie } });
      const body = await res.text();
      expect(body).toContain('<meta property="og:title" content="Test App" />');
      expect(body).toContain("<title>Test App</title>");
      expect(body).not.toContain("og:description");
    } finally {
      server.cleanup();
    }
  });

  test("gives a private artifact's title only to its creator", async () => {
    const server = await createTestServer({ serveClient: true });
    try {
      const cookie = await server.signIn();
      const other = await server.signIn({
        ...WORKSPACE_USER,
        sub: "google-subject-2",
        email: "other@acme.example",
        name: "B Person",
      });
      const upload = await uploadArtifact(server, cookie, { title: "Draft plan" });
      const { artifact } = (await upload.json()) as { artifact: { id: string } };
      const change = await server.app.request(`/api/artifacts/${artifact.id}/visibility`, {
        method: "PATCH",
        headers: { cookie, origin: TEST_BASE_URL, "content-type": "application/json" },
        body: JSON.stringify({ visibility: "private" }),
      });
      expect(change.status).toBe(200);

      // An unfurler sends no cookie, so a pasted link must not reveal the title.
      for (const headers of [{}, { cookie: other }] as Record<string, string>[]) {
        const body = await (await server.app.request(`/a/${artifact.id}`, { headers })).text();
        expect(body).toContain('<meta property="og:title" content="Test App" />');
        expect(body).not.toContain("Draft plan");
      }
      const own = await (
        await server.app.request(`/a/${artifact.id}`, { headers: { cookie } })
      ).text();
      expect(own).toContain('<meta property="og:title" content="Draft plan" />');
    } finally {
      server.cleanup();
    }
  });

  test("gives an anonymous request, such as a chat unfurler, the title and no content", async () => {
    // The privacy rule: whoever holds the link learns the title and nothing
    // more, since anyone can paste an artifact link into a public channel.
    const server = await createTestServer({ serveClient: true });
    try {
      const cookie = await server.signIn();
      const upload = await uploadArtifact(server, cookie, {
        title: "Q3 Roadmap",
        description: "Internal detail nobody outside the team should see.",
      });
      const { artifact } = (await upload.json()) as { artifact: { id: string } };

      const res = await server.app.request(`/a/${artifact.id}`);
      const body = await res.text();
      expect(body).toContain('<meta property="og:title" content="Q3 Roadmap" />');
      expect(body).toContain("<title>Q3 Roadmap</title>");
      expect(body).not.toContain('name="description"');
      expect(body).not.toContain("og:description");
      expect(body).not.toContain("Internal detail");
    } finally {
      server.cleanup();
    }
  });

  test("a signed-in request gets the artifact's own description", async () => {
    const server = await createTestServer({ serveClient: true });
    try {
      const cookie = await server.signIn();
      const upload = await uploadArtifact(server, cookie, {
        title: "Q3 Roadmap",
        description: "Handpicked summary for readers.",
      });
      const { artifact } = (await upload.json()) as { artifact: { id: string } };

      const res = await server.app.request(`/a/${artifact.id}`, { headers: { cookie } });
      const body = await res.text();
      expect(body).toContain(
        '<meta name="description" content="Handpicked summary for readers." />',
      );
      expect(body).toContain(
        '<meta property="og:description" content="Handpicked summary for readers." />',
      );
    } finally {
      server.cleanup();
    }
  });

  test("a signed-in request falls back to a Markdown excerpt when no description was set", async () => {
    const server = await createTestServer({ serveClient: true });
    try {
      const cookie = await server.signIn();
      const upload = await uploadArtifact(server, cookie, {
        title: "Growth report",
        html: "<p>Conversion improved twelve percent this quarter after the new onboarding flow shipped to every workspace.</p>",
      });
      const { artifact } = (await upload.json()) as { artifact: { id: string } };

      const markdownRes = await server.app.request(`/api/artifacts/${artifact.id}/markdown`, {
        headers: { cookie },
      });
      const { markdown } = (await markdownRes.json()) as { markdown: string };
      const expected = excerpt(markdown);
      expect(expected.length).toBeGreaterThan(0);

      const res = await server.app.request(`/a/${artifact.id}`, { headers: { cookie } });
      const body = await res.text();
      expect(body).toContain(`<meta property="og:description" content="${expected}" />`);
    } finally {
      server.cleanup();
    }
  });

  test("applies the same tags to the /full artifact view", async () => {
    const server = await createTestServer({ serveClient: true });
    try {
      const cookie = await server.signIn();
      const upload = await uploadArtifact(server, cookie, { title: "Q3 Roadmap" });
      const { artifact } = (await upload.json()) as { artifact: { id: string } };

      const res = await server.app.request(`/a/${artifact.id}/full`);
      const body = await res.text();
      expect(body).toContain('<meta property="og:title" content="Q3 Roadmap" />');
    } finally {
      server.cleanup();
    }
  });
});
