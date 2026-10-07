import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { escapeHtml } from "./social.ts";

/** Images the client build ships under /branding/. A deployment can replace each one. */
const IMAGES = [
  "logo-full.png",
  "logo-label.png",
  "logo-mark.png",
  "favicon-32.png",
  "apple-touch-icon.png",
  "social-preview.png",
];

/** Loaded after the application stylesheet, so its rules win. It has no default. */
export const BRAND_STYLESHEET = "brand.css";

export type BrandingFile = { body: Uint8Array<ArrayBuffer>; type: string; etag: string };

/**
 * The content of each /branding/ name: the deployment's copy when
 * `brandingDir` has one, the client build's otherwise. Read once at startup, so
 * a changed directory takes effect on restart.
 */
export function loadBranding(
  brandingDir: string | undefined,
  clientDist: string,
): ReadonlyMap<string, BrandingFile> {
  const paths = new Map(IMAGES.map((name) => [name, join(clientDist, "branding", name)]));
  if (brandingDir !== undefined) {
    const dir = resolve(brandingDir);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      throw new Error(`BRANDING_DIR ${dir} is not a directory`);
    }
    for (const name of [...IMAGES, BRAND_STYLESHEET]) {
      const path = join(dir, name);
      if (existsSync(path)) paths.set(name, path);
    }
  }

  const files = new Map<string, BrandingFile>();
  for (const [name, path] of paths) {
    if (!existsSync(path)) continue;
    const body = new Uint8Array(readFileSync(path));
    const etag = `"${createHash("sha256").update(body).digest("base64url").slice(0, 22)}"`;
    files.set(name, { body, type: Bun.file(path).type, etag });
  }
  return files;
}

/** Whether an If-None-Match header names `etag`, so the browser's copy is current. */
export function matchesEtag(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  return header.split(",").some((tag) => {
    const value = tag.trim();
    return value === "*" || value.replace(/^W\//, "") === etag;
  });
}

/** Puts the deployment's name into the built index.html, and links its stylesheet. */
export function withBranding(
  html: string,
  branding: { appName: string; stylesheet: boolean },
): string {
  const name = escapeHtml(branding.appName);
  const result = html
    .replace(/<title>[^<]*<\/title>/, () => `<title>${name}</title>`)
    .replace(
      /(<meta (?:property="og:site_name"|name="application-name") content=")[^"]*"/g,
      (_, start: string) => `${start}${name}"`,
    )
    .replace(
      /(<meta property="og:image:alt" content=")[^"]*"/,
      (_, start: string) => `${start}${name} logo"`,
    );
  if (!branding.stylesheet) return result;
  return result.replace(
    "</head>",
    () => `    <link rel="stylesheet" href="/branding/${BRAND_STYLESHEET}" />\n  </head>`,
  );
}
