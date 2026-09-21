import { describe, expect, test } from "bun:test";
import {
  createPreviewIssuer,
  mintPreviewToken,
  PREVIEW_TTL_SECONDS,
  verifyPreviewToken,
} from "./tokens.ts";

const SECRET = "session-secret-session-secret-32";
const SUBJECT = { artifactId: "artifact-1", versionId: "version-1" };

describe("verifyPreviewToken", () => {
  test("accepts a token this deployment issued", () => {
    const { token } = mintPreviewToken(SECRET, SUBJECT);
    expect(verifyPreviewToken(SECRET, token)).toEqual({ valid: true, ...SUBJECT });
  });

  test("refuses a token signed with another secret, so one deployment cannot mint for another", () => {
    const { token } = mintPreviewToken("another-secret-another-secret-32", SUBJECT);
    expect(verifyPreviewToken(SECRET, token).valid).toBe(false);
  });

  test("refuses a token whose artifact id was swapped for another", () => {
    const { token } = mintPreviewToken(SECRET, SUBJECT);
    const [version, , versionId, expiry, signature] = token.split(".");
    const otherId = Buffer.from("artifact-2", "utf8").toString("base64url");
    const forged = [version, otherId, versionId, expiry, signature].join(".");
    expect(verifyPreviewToken(SECRET, forged)).toEqual({ valid: false, reason: "signature" });
  });

  test("refuses a token whose version id was swapped, so one version cannot show another", () => {
    const { token } = mintPreviewToken(SECRET, SUBJECT);
    const [version, id, , expiry, signature] = token.split(".");
    const otherVersion = Buffer.from("version-2", "utf8").toString("base64url");
    const forged = [version, id, otherVersion, expiry, signature].join(".");
    expect(verifyPreviewToken(SECRET, forged)).toEqual({ valid: false, reason: "signature" });
  });

  test("refuses a token whose expiry was pushed further out", () => {
    const { token } = mintPreviewToken(SECRET, SUBJECT);
    const [version, id, versionId, expiry, signature] = token.split(".");
    const later = String(Number(expiry) + 86_400);
    expect(
      verifyPreviewToken(SECRET, [version, id, versionId, later, signature].join(".")),
    ).toEqual({
      valid: false,
      reason: "signature",
    });
  });

  test("refuses a token after it expires", () => {
    const { token } = mintPreviewToken(SECRET, SUBJECT);
    const later = new Date(Date.now() + (PREVIEW_TTL_SECONDS + 1) * 1000);
    expect(verifyPreviewToken(SECRET, token, later)).toEqual({ valid: false, reason: "expired" });
  });

  test("still accepts a token one second before it expires", () => {
    const { token, expiresAt } = mintPreviewToken(SECRET, SUBJECT);
    const justBefore = new Date(expiresAt.getTime() - 1000);
    expect(verifyPreviewToken(SECRET, token, justBefore).valid).toBe(true);
  });

  test("refuses anything that is not a token of this shape", () => {
    for (const token of [
      "",
      "nonsense",
      "v2.a.b",
      "v1.artifact.999.sig",
      "v2.a.b.999.sig",
      "v2.....",
    ]) {
      expect(verifyPreviewToken(SECRET, token).valid).toBe(false);
    }
  });

  test("keeps an artifact id containing a dot readable, which the format could hide", () => {
    const subject = { artifactId: "artifact.with.dots", versionId: "version.with.dots" };
    const { token } = mintPreviewToken(SECRET, subject);
    expect(verifyPreviewToken(SECRET, token)).toEqual({ valid: true, ...subject });
  });
});

describe("createPreviewIssuer", () => {
  test("points the browser at the content host, not at the application", () => {
    const issue = createPreviewIssuer({ secret: SECRET, contentOrigin: "https://content.test" });
    const { url, expiresAt } = issue(SUBJECT);

    expect(url.startsWith("https://content.test/preview/")).toBe(true);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  test("issues a token the content host accepts for that one artifact", () => {
    const issue = createPreviewIssuer({ secret: SECRET, contentOrigin: "https://content.test" });
    const url = issue(SUBJECT).url;
    expect(verifyPreviewToken(SECRET, url.split("/preview/")[1] ?? "")).toEqual({
      valid: true,
      ...SUBJECT,
    });
  });
});
