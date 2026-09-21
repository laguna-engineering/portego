import type { GoogleOptions, GoogleProfile } from "better-auth/social-providers";
import type { EnvSource } from "../../env.ts";
import { normalizeDomain } from "../policy.ts";
import type { ProviderDefinition } from "./types.ts";

export type GoogleSettings = {
  clientId: string;
  clientSecret: string;
  /**
   * Google Workspace hosted domain. Sent as the `hd` authorization hint and
   * enforced against the `hd` claim of the returned id token.
   */
  hostedDomain?: string;
};

export type ClaimCheck = { ok: true } | { ok: false; reason: string };

/**
 * Checks the claims of the verified Google id token. The `hd` authorization
 * parameter is only a hint: it travels in a URL the user can edit, so the
 * claim on the token is the value that decides.
 */
export function verifyGoogleClaims(
  profile: Pick<GoogleProfile, "email_verified" | "hd">,
  hostedDomain: string | undefined,
): ClaimCheck {
  if (profile.email_verified !== true) {
    return { ok: false, reason: "Google did not report the email address as verified" };
  }
  if (!hostedDomain) return { ok: true };

  const claim = profile.hd;
  if (typeof claim !== "string" || claim.trim() === "") {
    return { ok: false, reason: "the id token carries no hosted-domain (hd) claim" };
  }
  if (normalizeDomain(claim) !== hostedDomain) {
    return { ok: false, reason: `the hosted-domain (hd) claim is not ${hostedDomain}` };
  }
  return { ok: true };
}

export function readGoogleSettings(
  source: EnvSource,
): { ok: true; settings: GoogleSettings } | { ok: false; missing: string[] } {
  const clientId = source.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = source.GOOGLE_CLIENT_SECRET?.trim();
  const hostedDomain = source.GOOGLE_HOSTED_DOMAIN?.trim();

  const missing: string[] = [];
  if (!clientId) missing.push("GOOGLE_CLIENT_ID");
  if (!clientSecret) missing.push("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) return { ok: false, missing };

  return {
    ok: true,
    settings: {
      clientId,
      clientSecret,
      ...(hostedDomain ? { hostedDomain: normalizeDomain(hostedDomain) } : {}),
    },
  };
}

export function buildGoogleOptions(settings: GoogleSettings): GoogleOptions {
  return {
    clientId: settings.clientId,
    clientSecret: settings.clientSecret,
    ...(settings.hostedDomain ? { hd: settings.hostedDomain } : {}),
    // Ask for the account chooser every time. A shared browser otherwise
    // reuses whichever Google account signed in last.
    prompt: "select_account",
    mapProfileToUser: (profile) => {
      const check = verifyGoogleClaims(profile, settings.hostedDomain);
      // An identity that fails the claim check is mapped as unverified. The
      // admission policy refuses unverified identities, which keeps the refusal
      // in one provider-independent place.
      return { emailVerified: check.ok };
    },
  };
}

export const googleProvider: ProviderDefinition = {
  id: "google",
  defaultLabel: "Google",
  resolve(source) {
    const result = readGoogleSettings(source);
    if (!result.ok) return result;
    return { ok: true, wiring: { kind: "social", options: buildGoogleOptions(result.settings) } };
  },
};
