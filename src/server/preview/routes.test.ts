import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TEST_BASE_URL } from "../auth/testing.ts";
import { createTestServer, TEST_CONTENT_ORIGIN, type TestServer } from "../testing.ts";
import { withBridge } from "./bridge.ts";
import { HOSTILE_ARTIFACTS, SELF_CONTAINED_ARTIFACT } from "./fixtures/hostile.ts";
import { mintPreviewToken } from "./tokens.ts";

let server: TestServer;
let cookie: string;

beforeEach(async () => {
  server = await createTestServer();
  cookie = await server.signIn();
});

afterEach(() => {
  server.cleanup();
});

async function store(html: string): Promise<string> {
  const { artifact } = await server.artifacts.upload({
    bytes: new TextEncoder().encode(html),
    filename: "artifact.html",
    title: "An artifact",
    createdBy:
      (await server.auth.api.getSession({ headers: new Headers({ cookie }) }))?.user.id ?? "",
  });
  return artifact.id;
}

async function previewUrl(artifactId: string): Promise<string> {
  const res = await server.app.request(`/api/artifacts/${artifactId}/preview`, {
    method: "POST",
    headers: { cookie, origin: TEST_BASE_URL },
  });
  const body = (await res.json()) as { url: string };
  return body.url;
}

function onContentHost(url: string, init?: RequestInit) {
  return server.app.request(url, init);
}

describe("minting a preview URL", () => {
  test("issues a URL on the content host, never on the application host", async () => {
    const url = await previewUrl(await store(SELF_CONTAINED_ARTIFACT));
    expect(url.startsWith(`${TEST_CONTENT_ORIGIN}/preview/`)).toBe(true);
    expect(url.startsWith(TEST_BASE_URL)).toBe(false);
  });

  test("refuses to mint without a session", async () => {
    const id = await store(SELF_CONTAINED_ARTIFACT);
    const res = await server.app.request(`/api/artifacts/${id}/preview`, {
      method: "POST",
      headers: { origin: TEST_BASE_URL },
    });
    expect(res.status).toBe(401);
  });

  test("refuses to mint from another origin, which is the CSRF case", async () => {
    const id = await store(SELF_CONTAINED_ARTIFACT);
    const res = await server.app.request(`/api/artifacts/${id}/preview`, {
      method: "POST",
      headers: { cookie, origin: "https://attacker.example" },
    });
    expect(res.status).toBe(403);
  });

  test("refuses to mint for an artifact that does not exist", async () => {
    const res = await server.app.request("/api/artifacts/missing/preview", {
      method: "POST",
      headers: { cookie, origin: TEST_BASE_URL },
    });
    expect(res.status).toBe(404);
  });
});

describe("serving a preview", () => {
  test("returns the stored document with the comment bridge in its head", async () => {
    const url = await previewUrl(await store(SELF_CONTAINED_ARTIFACT));
    const res = await onContentHost(url);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    // The upload is intact around the one script the application adds, and
    // that script is the same one the unit tests exercise.
    expect(await res.text()).toBe(withBridge(SELF_CONTAINED_ARTIFACT));
  });

  test("needs no session, because the content host never receives the cookie", async () => {
    const url = await previewUrl(await store(SELF_CONTAINED_ARTIFACT));
    expect((await onContentHost(url)).status).toBe(200);
  });

  test("refuses a token minted for another artifact", async () => {
    const first = await store(SELF_CONTAINED_ARTIFACT);
    const second = await store(SELF_CONTAINED_ARTIFACT.replace("rendered", "second"));
    const url = await previewUrl(first);

    // Swapping the id in the URL cannot work: the id is signed into the token.
    const forged = url.replace(/\/preview\/.*$/, `/preview/${second}`);
    expect((await onContentHost(forged)).status).toBe(403);
  });

  test("refuses an expired token", async () => {
    const id = await store(SELF_CONTAINED_ARTIFACT);
    const past = new Date(Date.now() - 3_600_000);
    const { token } = mintPreviewToken(
      server.signingSecret,
      { artifactId: id, versionId: id },
      past,
    );
    expect((await onContentHost(`${TEST_CONTENT_ORIGIN}/preview/${token}`)).status).toBe(403);
  });

  test("refuses a made-up token", async () => {
    const res = await onContentHost(`${TEST_CONTENT_ORIGIN}/preview/v2.YQ.YQ.9999999999.nope`);
    expect(res.status).toBe(403);
  });

  test("says the same thing for a bad token and a missing artifact", async () => {
    const bad = await onContentHost(`${TEST_CONTENT_ORIGIN}/preview/v2.YQ.YQ.9999999999.nope`);
    const other = await onContentHost(`${TEST_CONTENT_ORIGIN}/preview/nonsense`);
    expect(await bad.text()).toBe(await other.text());
  });
});

describe("preview response headers", () => {
  async function headers() {
    const url = await previewUrl(await store(SELF_CONTAINED_ARTIFACT));
    const res = await onContentHost(url);
    return {
      csp: res.headers.get("content-security-policy") ?? "",
      all: res.headers,
    };
  }

  test("gives the document an opaque origin with scripts and nothing else", async () => {
    const { csp } = await headers();
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).not.toContain("allow-forms");
    expect(csp).not.toContain("allow-popups");
    expect(csp).not.toContain("allow-top-navigation");
  });

  test("blocks every network destination an artifact could reach for", async () => {
    const { csp } = await headers();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("worker-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("object-src 'none'");
  });

  test("allows the inline and embedded content a self-contained artifact needs", async () => {
    const { csp } = await headers();
    expect(csp).toContain("script-src 'unsafe-inline'");
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp).toContain("img-src data: blob:");
    expect(csp).toContain("font-src data:");
    expect(csp).toContain("media-src data: blob:");
  });

  test("lets only the application frame the preview", async () => {
    const { csp } = await headers();
    expect(csp).toContain(`frame-ancestors ${TEST_BASE_URL}`);
  });

  test("sends no referrer, no sniffing, and no stored copy", async () => {
    const { all } = await headers();
    expect(all.get("referrer-policy")).toBe("no-referrer");
    expect(all.get("x-content-type-options")).toBe("nosniff");
    expect(all.get("cache-control")).toBe("private, no-store");
  });

  // The whole header, spelled out rather than sampled. A directive that quietly
  // disappears is the failure worth catching, and a partial check cannot see it.
  test("denies every browser feature the policy names", async () => {
    const { all } = await headers();
    expect(all.get("permissions-policy")).toBe(
      [
        "accelerometer=()",
        "ambient-light-sensor=()",
        "autoplay=()",
        "camera=()",
        "clipboard-read=()",
        "clipboard-write=()",
        "display-capture=()",
        "encrypted-media=()",
        "fullscreen=()",
        "geolocation=()",
        "gyroscope=()",
        "magnetometer=()",
        "microphone=()",
        "midi=()",
        "payment=()",
        "publickey-credentials-get=()",
        "screen-wake-lock=()",
        "usb=()",
        "xr-spatial-tracking=()",
      ].join(", "),
    );
  });

  test("applies the same headers to every hostile document", async () => {
    for (const [attempt, html] of Object.entries(HOSTILE_ARTIFACTS)) {
      const url = await previewUrl(await store(html));
      const res = await onContentHost(url);
      const csp = res.headers.get("content-security-policy") ?? "";

      expect(res.status, attempt).toBe(200);
      expect(csp, attempt).toContain("sandbox allow-scripts");
      expect(csp, attempt).toContain("default-src 'none'");
      // The document is served as uploaded, plus the bridge. Nothing else
      // rewrites it; the headers are what make it harmless.
      expect(await res.text()).toBe(withBridge(html));
    }
  });
});

describe("host separation", () => {
  test("serves no preview on the application host", async () => {
    const url = await previewUrl(await store(SELF_CONTAINED_ARTIFACT));
    const onAppHost = url.replace(TEST_CONTENT_ORIGIN, TEST_BASE_URL);
    expect((await server.app.request(onAppHost)).status).toBe(404);
  });

  test("serves no auth, API, or application route on the content host", async () => {
    for (const path of [
      "/api/auth/get-session",
      "/api/auth-providers",
      "/api/me",
      "/api/artifacts",
      "/mcp",
      "/.well-known/oauth-protected-resource",
      "/healthz",
      "/",
      "/assets/index.js",
    ]) {
      const res = await onContentHost(`${TEST_CONTENT_ORIGIN}${path}`, { headers: { cookie } });
      expect(res.status, path).toBe(404);
    }
  });

  test("lists no directory on the content host", async () => {
    for (const path of ["/preview/", "/preview", "/artifacts/", "/artifacts"]) {
      const res = await onContentHost(`${TEST_CONTENT_ORIGIN}${path}`);
      expect(res.status, path).toBeGreaterThanOrEqual(400);
    }
  });
});
