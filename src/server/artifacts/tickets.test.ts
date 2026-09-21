import { describe, expect, test } from "bun:test";
import { mintPreviewToken, verifyPreviewToken } from "../preview/tokens.ts";
import {
  createUploadTicketIssuer,
  mintUploadTicket,
  UPLOAD_TICKET_TTL_SECONDS,
  verifyUploadTicket,
} from "./tickets.ts";

const SECRET = "session-secret-session-secret-32";

describe("verifyUploadTicket", () => {
  test("accepts a ticket this deployment issued", () => {
    const { ticket } = mintUploadTicket(SECRET, "user-1");
    expect(verifyUploadTicket(SECRET, ticket)).toEqual({ valid: true, userId: "user-1" });
  });

  test("refuses a ticket signed with another secret, so one deployment cannot mint for another", () => {
    const { ticket } = mintUploadTicket("another-secret-another-secret-32", "user-1");
    expect(verifyUploadTicket(SECRET, ticket).valid).toBe(false);
  });

  test("refuses a ticket whose user id was swapped, which would upload as someone else", () => {
    const { ticket } = mintUploadTicket(SECRET, "user-1");
    const [version, , expiry, signature] = ticket.split(".");
    const otherId = Buffer.from("user-2", "utf8").toString("base64url");
    const forged = [version, otherId, expiry, signature].join(".");
    expect(verifyUploadTicket(SECRET, forged)).toEqual({ valid: false, reason: "signature" });
  });

  test("refuses a ticket whose expiry was pushed further out", () => {
    const { ticket } = mintUploadTicket(SECRET, "user-1");
    const [version, id, expiry, signature] = ticket.split(".");
    const later = String(Number(expiry) + 86_400);
    expect(verifyUploadTicket(SECRET, [version, id, later, signature].join("."))).toEqual({
      valid: false,
      reason: "signature",
    });
  });

  test("refuses a ticket after it expires", () => {
    const { ticket } = mintUploadTicket(SECRET, "user-1");
    const later = new Date(Date.now() + (UPLOAD_TICKET_TTL_SECONDS + 1) * 1000);
    expect(verifyUploadTicket(SECRET, ticket, later)).toEqual({ valid: false, reason: "expired" });
  });

  test("still accepts a ticket one second before it expires", () => {
    const { ticket, expiresAt } = mintUploadTicket(SECRET, "user-1");
    const justBefore = new Date(expiresAt.getTime() - 1000);
    expect(verifyUploadTicket(SECRET, ticket, justBefore).valid).toBe(true);
  });

  test("refuses anything that is not a ticket of this shape", () => {
    for (const ticket of ["", "nonsense", "v1.a.b", "v2.user.999.sig", "v1...."]) {
      expect(verifyUploadTicket(SECRET, ticket).valid).toBe(false);
    }
  });

  test("keeps a user id containing a dot readable, which the format could hide", () => {
    const { ticket } = mintUploadTicket(SECRET, "user.with.dots");
    expect(verifyUploadTicket(SECRET, ticket)).toEqual({ valid: true, userId: "user.with.dots" });
  });

  // Both capabilities are derived from the session secret and share a shape, so
  // the only thing keeping a read capability from becoming a write capability
  // is that each derives its own key.
  test("refuses a preview token, which a read capability must not become a write one", () => {
    const { token } = mintPreviewToken(SECRET, {
      artifactId: "artifact-1",
      versionId: "version-1",
    });
    expect(verifyUploadTicket(SECRET, token).valid).toBe(false);
  });

  test("mints a ticket the preview host refuses", () => {
    const { ticket } = mintUploadTicket(SECRET, "user-1");
    expect(verifyPreviewToken(SECRET, ticket).valid).toBe(false);
  });
});

describe("createUploadTicketIssuer", () => {
  test("points the client at the application host, which is where uploads land", () => {
    const issue = createUploadTicketIssuer({ secret: SECRET, appOrigin: "https://app.test" });
    const { url, expiresAt } = issue("user-1");

    expect(url).toBe("https://app.test/api/uploads");
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  test("keeps the ticket out of the URL, so a proxy access log does not record it", () => {
    const issue = createUploadTicketIssuer({ secret: SECRET, appOrigin: "https://app.test" });
    const { url, ticket } = issue("user-1");

    expect(url).not.toContain(ticket);
    expect(verifyUploadTicket(SECRET, ticket)).toEqual({ valid: true, userId: "user-1" });
  });
});
