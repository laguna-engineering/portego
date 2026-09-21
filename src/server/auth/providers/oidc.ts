import type { GenericOAuthConfig } from "better-auth/plugins/generic-oauth";
import type { EnvSource } from "../../env.ts";
import type { ProviderDefinition } from "./types.ts";

export const PROVIDER_ID = "oidc";

const DEFAULT_SCOPES = ["openid", "profile", "email"];
const DEFAULT_LABEL = "Single sign-on";
const DISCOVERY_PATH = "/.well-known/openid-configuration";

export type OidcSettings = {
  discoveryUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  label: string;
};

/**
 * Accepts either an issuer URL or a full discovery URL, because operators have
 * one or the other in front of them.
 */
export function discoveryUrlFor(issuer: string): string | null {
  let url: URL;
  try {
    url = new URL(issuer.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    return null;
  }
  if (url.pathname.endsWith(DISCOVERY_PATH)) return url.toString();
  return `${url.toString().replace(/\/+$/, "")}${DISCOVERY_PATH}`;
}

export function readOidcSettings(
  source: EnvSource,
): { ok: true; settings: OidcSettings } | { ok: false; missing: string[] } {
  const issuer = source.OIDC_ISSUER_URL?.trim();
  const clientId = source.OIDC_CLIENT_ID?.trim();
  const clientSecret = source.OIDC_CLIENT_SECRET?.trim();

  const missing: string[] = [];
  if (!issuer) missing.push("OIDC_ISSUER_URL");
  if (!clientId) missing.push("OIDC_CLIENT_ID");
  if (!clientSecret) missing.push("OIDC_CLIENT_SECRET");
  if (!issuer || !clientId || !clientSecret) return { ok: false, missing };

  const discoveryUrl = discoveryUrlFor(issuer);
  if (!discoveryUrl) {
    // The same list startup prints, so the operator sees which value is wrong.
    return { ok: false, missing: ["OIDC_ISSUER_URL (must be an https URL)"] };
  }

  const scopes = (source.OIDC_SCOPES ?? "")
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter((scope) => scope !== "");

  return {
    ok: true,
    settings: {
      discoveryUrl,
      clientId,
      clientSecret,
      scopes: scopes.length > 0 ? scopes : DEFAULT_SCOPES,
      label: source.OIDC_LABEL?.trim() || DEFAULT_LABEL,
    },
  };
}

export function buildOidcConfig(settings: OidcSettings): GenericOAuthConfig {
  return {
    providerId: PROVIDER_ID,
    name: settings.label,
    discoveryUrl: settings.discoveryUrl,
    clientId: settings.clientId,
    clientSecret: settings.clientSecret,
    scopes: settings.scopes,
    // Authorization Code with PKCE, and an id token that has to verify against
    // the issuer's keys. Nonce binding stays on, so a token minted for another
    // sign-in attempt cannot be replayed into this one.
    pkce: true,
    requireIdTokenVerification: true,
    mapProfileToUser: (profile) => ({
      // The provider decides whether it has verified the address. The
      // admission policy decides what that is worth.
      emailVerified: profile.email_verified === true,
    }),
  };
}

export const oidcProvider: ProviderDefinition = {
  id: PROVIDER_ID,
  defaultLabel: DEFAULT_LABEL,
  resolve(source) {
    const result = readOidcSettings(source);
    if (!result.ok) return result;
    return {
      ok: true,
      label: result.settings.label,
      wiring: { kind: "oidc", config: buildOidcConfig(result.settings) },
    };
  },
};
