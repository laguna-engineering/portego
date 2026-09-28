import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TEST_BASE_URL } from "../auth/testing.ts";
import { pngBytes } from "../storage/testing.ts";
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

describe("serving a preview's images", () => {
  const IMAGE_PAGE =
    '<!doctype html><title>Chart</title><img src="images/chart.png" alt="A chart">';

  async function storeWithImages(
    images: { name: string; seed?: string }[],
    artifactId?: string,
  ): Promise<string> {
    const { artifact } = await server.artifacts.upload({
      bytes: new TextEncoder().encode(IMAGE_PAGE),
      filename: "artifact.html",
      title: "Chart",
      images: images.map((image) => ({ name: image.name, bytes: pngBytes(image.seed) })),
      ...(artifactId ? { artifactId } : {}),
      createdBy:
        (await server.auth.api.getSession({ headers: new Headers({ cookie }) }))?.user.id ?? "",
    });
    return artifact.id;
  }

  test("serves an image at the path the document's relative src resolves to", async () => {
    const url = await previewUrl(await storeWithImages([{ name: "chart.png" }]));

    const res = await onContentHost(new URL("images/chart.png", url).href);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(pngBytes());
  });

  test("lets the document load images from its own token's path and from nowhere else", async () => {
    const url = await previewUrl(await storeWithImages([{ name: "chart.png" }]));
    const csp = (await onContentHost(url)).headers.get("content-security-policy") ?? "";

    const imgSrc = csp.split("; ").find((directive) => directive.startsWith("img-src"));
    expect(imgSrc).toBe(`img-src data: blob: ${new URL("images/", url).href}`);
    expect(csp).toContain("connect-src 'none'");
  });

  test("serves each image with the type detected at upload, unsniffable and inert", async () => {
    const url = await previewUrl(await storeWithImages([{ name: "chart.png" }]));
    const res = await onContentHost(new URL("images/chart.png", url).href);

    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  test("allows the sandboxed document to embed its images despite its opaque origin", async () => {
    const url = await previewUrl(await storeWithImages([{ name: "chart.png" }]));
    const res = await onContentHost(new URL("images/chart.png", url).href);
    expect(res.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
  });

  test("shows each version the images it was uploaded with", async () => {
    const id = await storeWithImages([{ name: "chart.png", seed: "v1" }]);
    const oldUrl = await previewUrl(id);
    await storeWithImages([{ name: "chart.png", seed: "v2" }], id);
    const newUrl = await previewUrl(id);

    const old = await onContentHost(new URL("images/chart.png", oldUrl).href);
    const current = await onContentHost(new URL("images/chart.png", newUrl).href);
    expect(new Uint8Array(await old.arrayBuffer())).toEqual(pngBytes("v1"));
    expect(new Uint8Array(await current.arrayBuffer())).toEqual(pngBytes("v2"));
  });

  test("serves no image of another artifact, whatever name is asked for", async () => {
    await storeWithImages([{ name: "secret.png" }]);
    const url = await previewUrl(await store(SELF_CONTAINED_ARTIFACT));

    const res = await onContentHost(new URL("images/secret.png", url).href);
    expect(res.status).toBe(404);
  });

  test("refuses an image request without a valid token", async () => {
    const url = await previewUrl(await storeWithImages([{ name: "chart.png" }]));
    const token = new URL(url).pathname.split("/")[2] ?? "";
    const tampered = new URL(`images/chart.png`, url.replace(token, `${token}x`)).href;
    expect((await onContentHost(tampered)).status).toBe(403);
  });

  test("refuses an expired token for an image as it does for the page", async () => {
    const id = await storeWithImages([{ name: "chart.png" }]);
    const { token } = mintPreviewToken(
      server.signingSecret,
      { artifactId: id, versionId: id },
      new Date(Date.now() - 3_600_000),
    );
    const res = await onContentHost(`${TEST_CONTENT_ORIGIN}/preview/${token}/images/chart.png`);
    expect(res.status).toBe(403);
  });

  test("answers a path-like name with not found and never reads outside the store", async () => {
    const url = await previewUrl(await storeWithImages([{ name: "chart.png" }]));
    const base = url.replace(/\/$/, "");
    for (const name of ["..%2F..%2Fapp.db", "..%5Capp.db", ".chart.png"]) {
      const res = await onContentHost(`${base}/images/${name}`);
      expect(res.status, name).toBe(404);
    }
  });

  test("serves images on the content host only", async () => {
    const url = await previewUrl(await storeWithImages([{ name: "chart.png" }]));
    const onAppHost = new URL("images/chart.png", url).href.replace(
      TEST_CONTENT_ORIGIN,
      TEST_BASE_URL,
    );
    expect((await server.app.request(onAppHost)).status).toBe(404);
  });
});
