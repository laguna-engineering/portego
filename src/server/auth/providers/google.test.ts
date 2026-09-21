import { describe, expect, test } from "bun:test";
import { buildGoogleOptions, readGoogleSettings, verifyGoogleClaims } from "./google.ts";

describe("verifyGoogleClaims", () => {
  const verified = { email_verified: true, hd: "acme.example" };

  test("accepts the hosted domain the deployment configured", () => {
    expect(verifyGoogleClaims(verified, "acme.example").ok).toBe(true);
  });

  test("refuses a token with no hd claim, which a personal Gmail account returns", () => {
    expect(verifyGoogleClaims({ email_verified: true }, "acme.example").ok).toBe(false);
  });

  test("refuses an hd claim naming another Workspace", () => {
    expect(verifyGoogleClaims({ ...verified, hd: "other.example" }, "acme.example").ok).toBe(false);
  });

  test("refuses an hd claim that only ends with the configured domain", () => {
    const claim = { ...verified, hd: "evil-acme.example" };
    expect(verifyGoogleClaims(claim, "acme.example").ok).toBe(false);
  });

  test("accepts a differently cased hd claim, because domains are case-insensitive", () => {
    expect(verifyGoogleClaims({ ...verified, hd: "Acme.Example" }, "acme.example").ok).toBe(true);
  });

  test("refuses an unverified email even when the hosted domain matches", () => {
    expect(verifyGoogleClaims({ ...verified, email_verified: false }, "acme.example").ok).toBe(
      false,
    );
  });

  test("skips the hosted-domain check when the deployment configured none", () => {
    expect(verifyGoogleClaims({ email_verified: true }, undefined).ok).toBe(true);
  });
});

describe("readGoogleSettings", () => {
  const credentials = { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" };

  test("names every missing credential at once", () => {
    expect(readGoogleSettings({})).toEqual({
      ok: false,
      missing: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    });
  });

  test("normalizes the hosted domain so the claim comparison can be exact", () => {
    const result = readGoogleSettings({
      ...credentials,
      GOOGLE_HOSTED_DOMAIN: " Acme.Example ",
    });
    expect(result).toEqual({
      ok: true,
      settings: { clientId: "id", clientSecret: "secret", hostedDomain: "acme.example" },
    });
  });

  test("leaves the hosted domain unset when the deployment is not Workspace-only", () => {
    const result = readGoogleSettings(credentials);
    expect(result.ok && result.settings.hostedDomain).toBeUndefined();
  });
});

describe("buildGoogleOptions", () => {
  test("sends the hosted domain to Google as the hd hint", () => {
    const options = buildGoogleOptions({
      clientId: "id",
      clientSecret: "secret",
      hostedDomain: "acme.example",
    });
    expect(options.hd).toBe("acme.example");
  });

  test("marks a profile that fails the claim check as unverified, so admission refuses it", async () => {
    const options = buildGoogleOptions({
      clientId: "id",
      clientSecret: "secret",
      hostedDomain: "acme.example",
    });
    const mapped = await options.mapProfileToUser?.({
      email: "person@acme.example",
      email_verified: true,
      hd: "other.example",
    } as Parameters<NonNullable<typeof options.mapProfileToUser>>[0]);
    expect(mapped?.emailVerified).toBe(false);
  });
});
