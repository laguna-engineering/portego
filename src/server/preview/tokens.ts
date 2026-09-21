import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * A preview token is a capability: it lets a browser with no session read one
 * version of one artifact from the content host. It is signed, short-lived,
 * bound to that version, and bound to this one purpose, so it cannot be
 * presented to anything else.
 */
const VERSION = "v2";

/** Long enough to load an iframe, short enough that a leaked URL is stale fast. */
export const PREVIEW_TTL_SECONDS = 300;

export type PreviewToken = { token: string; expiresAt: Date };

export type PreviewSubject = { artifactId: string; versionId: string };

export type VerifyResult =
  | ({ valid: true } & PreviewSubject)
  | { valid: false; reason: "malformed" | "expired" | "signature" };

/**
 * The session secret signs sessions. Previews use a key derived from it, so a
 * preview token can never be confused with, or turned into, anything else.
 */
function previewKey(secret: string): Buffer {
  return createHmac("sha256", secret).update(`preview-token-${VERSION}`).digest();
}

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function sign(secret: string, subject: PreviewSubject, expiresAt: number): string {
  // Each id is encoded on its own, so neither can run into the other.
  return createHmac("sha256", previewKey(secret))
    .update(
      `preview:${VERSION}:${encode(subject.artifactId)}:${encode(subject.versionId)}:${expiresAt}`,
    )
    .digest("base64url");
}

export function mintPreviewToken(
  secret: string,
  subject: PreviewSubject,
  now: Date = new Date(),
): PreviewToken {
  const expiresAt = Math.floor(now.getTime() / 1000) + PREVIEW_TTL_SECONDS;
  const signature = sign(secret, subject, expiresAt);
  return {
    token: `${VERSION}.${encode(subject.artifactId)}.${encode(subject.versionId)}.${expiresAt}.${signature}`,
    expiresAt: new Date(expiresAt * 1000),
  };
}

export function verifyPreviewToken(
  secret: string,
  token: string,
  now: Date = new Date(),
): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 5) return { valid: false, reason: "malformed" };
  const [version, encodedId, encodedVersionId, expiryText, signature] = parts;
  if (version !== VERSION || !encodedId || !encodedVersionId || !expiryText || !signature) {
    return { valid: false, reason: "malformed" };
  }

  const expiresAt = Number(expiryText);
  if (!Number.isSafeInteger(expiresAt)) return { valid: false, reason: "malformed" };

  // The ids are encoded rather than inlined, so an id containing the
  // separator cannot change how the rest of the token is read.
  const artifactId = Buffer.from(encodedId, "base64url").toString("utf8");
  const versionId = Buffer.from(encodedVersionId, "base64url").toString("utf8");
  if (artifactId === "" || versionId === "") return { valid: false, reason: "malformed" };

  // The signature is checked before the clock, so an expired token still has
  // to be one this deployment issued.
  const expected = Buffer.from(sign(secret, { artifactId, versionId }, expiresAt));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { valid: false, reason: "signature" };
  }
  if (expiresAt * 1000 <= now.getTime()) return { valid: false, reason: "expired" };

  return { valid: true, artifactId, versionId };
}

export type PreviewIssuer = (subject: PreviewSubject) => { url: string; expiresAt: Date };

/**
 * Builds the URL the browser loads in the preview iframe. It points at the
 * content host, which serves nothing else.
 */
export function createPreviewIssuer(options: {
  secret: string;
  contentOrigin: string;
}): PreviewIssuer {
  return (subject) => {
    const { token, expiresAt } = mintPreviewToken(options.secret, subject);
    return { url: `${options.contentOrigin}/preview/${token}`, expiresAt };
  };
}
