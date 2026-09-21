import type { Env, EnvSource } from "../env.ts";
import { type AdmissionPolicy, parseAllowedDomains } from "./policy.ts";
import { type PublicProvider, type ResolvedProvider, resolveProviders } from "./providers/index.ts";

/** Scopes an MCP client can hold. Reads and writes are separate on purpose. */
export const MCP_SCOPES = ["artifacts:read", "artifacts:write"] as const;

/** Without this scope the token endpoint issues no refresh token. */
export const REFRESH_SCOPE = "offline_access";

export type McpConfig = {
  /** The exact MCP URL. Tokens are bound to it as their audience. */
  resource: string;
  loginPage: string;
  consentPage: string;
  /**
   * Off by default. Client ID Metadata Documents are the supported way to
   * register; open registration is a compatibility fallback for a client that
   * cannot use them.
   */
  allowDynamicClientRegistration: boolean;
};

export type AuthConfig = {
  /** Shown on the sign-in page and by the OAuth consent screen. */
  appName: string;
  /** Public origin. Better Auth builds callback URLs from it. */
  baseURL: string;
  secret: string;
  /** Cookie name prefix. Keep it stable: changing it signs everybody out. */
  cookiePrefix: string;
  useSecureCookies: boolean;
  providers: ResolvedProvider[];
  admission: AdmissionPolicy;
  mcp: McpConfig;
};

const COOKIE_PREFIX = "portego";

/**
 * Development runs without a real signing key so a fresh checkout starts.
 * Production refuses to start without SESSION_SECRET, so this value can never
 * reach a deployment.
 */
const DEVELOPMENT_SECRET = "development-only-secret-do-not-use-in-production";

function readList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== "");
}

function readBoolean(
  value: string | undefined,
): { ok: true; value: boolean } | { ok: false; value: string } {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (normalized === "" || normalized === "false") return { ok: true, value: false };
  if (normalized === "true") return { ok: true, value: true };
  return { ok: false, value: normalized };
}

/**
 * Builds the authentication configuration and validates it. Throws with every
 * problem listed, because a deployment that cannot admit anybody should fail at
 * startup rather than at the first sign-in attempt.
 */
export function parseAuthConfig(env: Env, source: EnvSource): AuthConfig {
  const errors: string[] = [];

  const ids = readList(source.AUTH_PROVIDERS);
  if (ids.length === 0 && env.NODE_ENV === "production") {
    errors.push("AUTH_PROVIDERS is empty, so no one could sign in");
  }
  const resolved = resolveProviders(ids, source);
  errors.push(...resolved.errors);

  const admission = readAdmissionPolicy(source, errors);

  const dynamicRegistration = readBoolean(source.MCP_ALLOW_DYNAMIC_CLIENT_REGISTRATION);
  if (!dynamicRegistration.ok) {
    errors.push(
      `MCP_ALLOW_DYNAMIC_CLIENT_REGISTRATION must be true or false, not "${dynamicRegistration.value}"`,
    );
  }

  if (errors.length > 0) {
    const details = errors.map((error) => `  ${error}`).join("\n");
    throw new Error(`Invalid authentication configuration:\n${details}`);
  }

  return {
    appName: env.APP_NAME,
    baseURL: env.APP_URL,
    secret: env.SESSION_SECRET ?? DEVELOPMENT_SECRET,
    cookiePrefix: COOKIE_PREFIX,
    useSecureCookies: env.NODE_ENV === "production",
    providers: resolved.providers,
    admission,
    mcp: {
      resource: `${env.APP_URL}/mcp`,
      loginPage: "/mcp/login",
      consentPage: "/mcp/consent",
      allowDynamicClientRegistration: dynamicRegistration.ok ? dynamicRegistration.value : false,
    },
  };
}

function readAdmissionPolicy(source: EnvSource, errors: string[]): AdmissionPolicy {
  const allowAll = readBoolean(source.AUTH_ALLOW_ALL_AUTHENTICATED);
  if (!allowAll.ok) {
    errors.push(`AUTH_ALLOW_ALL_AUTHENTICATED must be true or false, not "${allowAll.value}"`);
  }

  const parsed = parseAllowedDomains(source.AUTH_ALLOWED_EMAIL_DOMAINS ?? "");
  if (!parsed.ok) {
    errors.push(`AUTH_ALLOWED_EMAIL_DOMAINS contains "${parsed.invalid}", which is not a domain`);
    return { kind: "email-domains", domains: [] };
  }

  if (allowAll.ok && allowAll.value) {
    if (parsed.domains.length > 0) {
      errors.push(
        "AUTH_ALLOW_ALL_AUTHENTICATED and AUTH_ALLOWED_EMAIL_DOMAINS are both set; keep one",
      );
    }
    return { kind: "all-authenticated" };
  }

  if (parsed.domains.length === 0) {
    errors.push(
      "no one is admitted: set AUTH_ALLOWED_EMAIL_DOMAINS, or set AUTH_ALLOW_ALL_AUTHENTICATED=true to admit every authenticated identity",
    );
  }
  return { kind: "email-domains", domains: parsed.domains };
}

/** Provider metadata for the sign-in page. Credentials never leave the server. */
export function publicProviders(config: AuthConfig): PublicProvider[] {
  return config.providers.map(({ id, label }) => ({ id, label }));
}
