import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBranding, matchesEtag, withBranding } from "./branding.ts";

describe("loadBranding", () => {
  let dir: string;
  let clientDist: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "branding-"));
    clientDist = join(dir, "client");
    mkdirSync(join(clientDist, "branding"), { recursive: true });
    writeFileSync(join(clientDist, "branding", "logo-mark.png"), "default-mark");
    writeFileSync(join(clientDist, "branding", "logo-full.png"), "default-full");
    mkdirSync(join(dir, "brand"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const text = (file: { body: Uint8Array } | undefined) =>
    file ? new TextDecoder().decode(file.body) : undefined;

  test("serves the client build's images when no directory is set", () => {
    const files = loadBranding(undefined, clientDist);
    expect(text(files.get("logo-mark.png"))).toBe("default-mark");
    expect(files.get("logo-mark.png")?.type).toBe("image/png");
    expect(files.has("brand.css")).toBe(false);
  });

  test("replaces only the files the directory holds, so a deployment can change one logo", () => {
    writeFileSync(join(dir, "brand", "logo-mark.png"), "acme-mark");
    writeFileSync(join(dir, "brand", "brand.css"), ":root {}");

    const files = loadBranding(join(dir, "brand"), clientDist);
    expect(text(files.get("logo-mark.png"))).toBe("acme-mark");
    expect(text(files.get("logo-full.png"))).toBe("default-full");
    expect(files.get("brand.css")?.type).toMatch(/^text\/css/);
  });

  test("leaves out a name with no file anywhere, so it is a 404", () => {
    expect(loadBranding(undefined, clientDist).has("favicon-32.png")).toBe(false);
  });

  test("ignores files outside the known names, so the directory cannot publish anything else", () => {
    writeFileSync(join(dir, "brand", "secrets.env"), "x");
    expect(loadBranding(join(dir, "brand"), clientDist).has("secrets.env")).toBe(false);
  });

  test("gives a replaced file a new ETag, so browsers fetch it after a restart", () => {
    const before = loadBranding(undefined, clientDist).get("logo-mark.png")?.etag;
    writeFileSync(join(dir, "brand", "logo-mark.png"), "acme-mark");
    const after = loadBranding(join(dir, "brand"), clientDist).get("logo-mark.png")?.etag;
    expect(before).toMatch(/^"[\w-]+"$/);
    expect(after).not.toBe(before);
  });

  test("refuses to start with a directory that does not exist, instead of showing the defaults", () => {
    expect(() => loadBranding(join(dir, "missing"), clientDist)).toThrow(/BRANDING_DIR/);
  });
});

describe("matchesEtag", () => {
  test("matches the tag in any position, weak or strong", () => {
    expect(matchesEtag('"a", W/"b"', '"b"')).toBe(true);
    expect(matchesEtag('"b"', '"b"')).toBe(true);
    expect(matchesEtag("*", '"b"')).toBe(true);
  });

  test("does not match another tag or a missing header", () => {
    expect(matchesEtag('"a"', '"b"')).toBe(false);
    expect(matchesEtag(undefined, '"b"')).toBe(false);
  });
});

describe("withBranding", () => {
  const html = [
    "<head>",
    "<title>Portego</title>",
    '<meta name="application-name" content="Portego" />',
    '<meta property="og:site_name" content="Portego" />',
    '<meta property="og:image:alt" content="Portego logo" />',
    "</head>",
  ].join("\n");

  test("puts the deployment's name everywhere the page names itself", () => {
    const result = withBranding(html, { appName: "Acme Share", stylesheet: false });
    expect(result).toContain("<title>Acme Share</title>");
    expect(result).toContain('<meta name="application-name" content="Acme Share" />');
    expect(result).toContain('<meta property="og:site_name" content="Acme Share" />');
    expect(result).toContain('<meta property="og:image:alt" content="Acme Share logo" />');
    expect(result).not.toContain("Portego");
  });

  test("escapes the name so it cannot break the markup", () => {
    const result = withBranding(html, { appName: 'A "B" <C> & $&', stylesheet: false });
    expect(result).toContain("<title>A &quot;B&quot; &lt;C&gt; &amp; $&amp;</title>");
  });

  test("links the stylesheet last in the head only when the deployment has one", () => {
    expect(withBranding(html, { appName: "x", stylesheet: false })).not.toContain("brand.css");
    expect(withBranding(html, { appName: "x", stylesheet: true })).toContain(
      '<link rel="stylesheet" href="/branding/brand.css" />\n  </head>',
    );
  });
});
