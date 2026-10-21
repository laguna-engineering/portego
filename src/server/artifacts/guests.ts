import { createHmac, timingSafeEqual } from "node:crypto";
import type { Guest } from "./service.ts";

/**
 * A guest token says who wrote an entry through a public link: one name, on
 * one artifact. It does not expire, so a guest who comes back keeps their
 * entries. It writes only while the link works, so revoking the link is what
 * ends it.
 */
const VERSION = "v1";

/** A key derived under its own label, so this token is never accepted as another kind. */
function guestKey(secret: string): Buffer {
  return createHmac("sha256", secret).update(`guest-token-${VERSION}`).digest();
}

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function sign(secret: string, encoded: string): string {
  return createHmac("sha256", guestKey(secret))
    .update(`guest:${VERSION}:${encoded}`)
    .digest("base64url");
}

export function mintGuestToken(secret: string, guest: Guest): string {
  // Each part is encoded on its own, so a name with a dot cannot change how it is read.
  const encoded = [guest.artifactId, guest.guestId, guest.name].map(encode).join(".");
  return `${VERSION}.${encoded}.${sign(secret, encoded)}`;
}

/** Null for any token this deployment did not issue. */
export function verifyGuestToken(secret: string, token: string): Guest | null {
  const parts = token.split(".");
  if (parts.length !== 5 || parts[0] !== VERSION) return null;
  const [, artifactId, guestId, name, signature] = parts;
  if (!artifactId || !guestId || !name || !signature) return null;
  const encoded = `${artifactId}.${guestId}.${name}`;
  const expected = Buffer.from(sign(secret, encoded));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return { artifactId: decode(artifactId), guestId: decode(guestId), name: decode(name) };
}
