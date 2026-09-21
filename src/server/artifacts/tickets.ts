import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * An upload ticket is a capability: it lets a client with no session create one
 * artifact as one user. It is signed, short-lived, and bound to this one
 * purpose, so it cannot be presented to anything else.
 *
 * It exists because an MCP tool call carries JSON, so `upload_artifact` has to
 * put the whole document in an argument. A ticket moves the bytes out of the
 * JSON-RPC body and out of the model's context.
 */
const VERSION = "v1";

/** Long enough to run one command, short enough that a leaked ticket is stale fast. */
export const UPLOAD_TICKET_TTL_SECONDS = 300;

export type UploadTicket = { ticket: string; expiresAt: Date };

export type VerifyResult =
  | { valid: true; userId: string }
  | { valid: false; reason: "malformed" | "expired" | "signature" };

/**
 * The session secret signs sessions. Upload tickets use a key derived from it
 * under their own label, so a preview token and an upload ticket can never be
 * presented for each other's purpose.
 */
function ticketKey(secret: string): Buffer {
  return createHmac("sha256", secret).update(`upload-ticket-${VERSION}`).digest();
}

function sign(secret: string, userId: string, expiresAt: number): string {
  return createHmac("sha256", ticketKey(secret))
    .update(`upload:${VERSION}:${userId}:${expiresAt}`)
    .digest("base64url");
}

export function mintUploadTicket(
  secret: string,
  userId: string,
  now: Date = new Date(),
): UploadTicket {
  const expiresAt = Math.floor(now.getTime() / 1000) + UPLOAD_TICKET_TTL_SECONDS;
  const signature = sign(secret, userId, expiresAt);
  const encodedId = Buffer.from(userId, "utf8").toString("base64url");
  return {
    ticket: `${VERSION}.${encodedId}.${expiresAt}.${signature}`,
    expiresAt: new Date(expiresAt * 1000),
  };
}

export function verifyUploadTicket(
  secret: string,
  ticket: string,
  now: Date = new Date(),
): VerifyResult {
  const parts = ticket.split(".");
  if (parts.length !== 4) return { valid: false, reason: "malformed" };
  const [version, encodedId, expiryText, signature] = parts;
  if (version !== VERSION || !encodedId || !expiryText || !signature) {
    return { valid: false, reason: "malformed" };
  }

  const expiresAt = Number(expiryText);
  if (!Number.isSafeInteger(expiresAt)) return { valid: false, reason: "malformed" };

  // The id is encoded rather than inlined, so an id containing the separator
  // cannot change how the rest of the ticket is read.
  const userId = Buffer.from(encodedId, "base64url").toString("utf8");
  if (userId === "") return { valid: false, reason: "malformed" };

  // The signature is checked before the clock, so an expired ticket still has
  // to be one this deployment issued.
  const expected = Buffer.from(sign(secret, userId, expiresAt));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { valid: false, reason: "signature" };
  }
  if (expiresAt * 1000 <= now.getTime()) return { valid: false, reason: "expired" };

  return { valid: true, userId };
}

export type UploadTicketIssuer = (userId: string) => {
  url: string;
  ticket: string;
  expiresAt: Date;
};

/**
 * Builds what a client needs to send an upload: where to send it, and the
 * ticket that authorizes it. The ticket travels in the Authorization header
 * rather than the URL, so a reverse proxy's access log does not record it.
 */
export function createUploadTicketIssuer(options: {
  secret: string;
  appOrigin: string;
}): UploadTicketIssuer {
  return (userId) => {
    const { ticket, expiresAt } = mintUploadTicket(options.secret, userId);
    return { url: `${options.appOrigin}/api/uploads`, ticket, expiresAt };
  };
}
