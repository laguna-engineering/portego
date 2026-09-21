/**
 * Test support for authentication. Tests wire a provider that answers offline,
 * so no test calls Google and no test needs OAuth credentials.
 */
import { Database } from "bun:sqlite";
import { getMigrations } from "better-auth/db/migration";
import { type Auth, createAuth } from "./auth.ts";
import type { AuthConfig } from "./config.ts";
import { buildGoogleOptions, type GoogleSettings } from "./providers/google.ts";
import type { ResolvedProvider } from "./providers/index.ts";

export const TEST_BASE_URL = "http://localhost:5173";

export type TestClaims = {
  sub: string;
  email: string;
  email_verified: boolean;
  hd?: string;
  name?: string;
};

/**
 * Builds an unsigned id token. Better Auth decodes the token to read its
 * claims and asks the provider to verify it, so a test provider that accepts
 * every token exercises the real claim handling without a signing key.
 */
export function idToken(claims: TestClaims): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({
    iss: "https://accounts.google.com",
    aud: "test-client-id",
    picture: "https://example.test/avatar.png",
    ...claims,
  })}.`;
}

export type TestAuthOptions = {
  domains?: string[];
  allowAll?: boolean;
  hostedDomain?: string;
  /** Use this database instead of a throwaway in-memory one. */
  database?: Database;
  /** The origin the app answers on. Defaults to TEST_BASE_URL. */
  baseURL?: string;
  /** Providers to enable instead of the offline Google stub. */
  providers?: ResolvedProvider[];
};

/** An auth instance backed by a throwaway in-memory database. */
/**
 * The Google provider tests use: real option building, real claim handling, and
 * a signature check that accepts the locally minted token.
 */
export function googleTestProvider(hostedDomain?: string): ResolvedProvider {
  const settings: GoogleSettings = {
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    ...(hostedDomain ? { hostedDomain } : {}),
  };
  return {
    id: "google",
    label: "Google",
    wiring: {
      kind: "social",
      options: {
        ...buildGoogleOptions(settings),
        // The signature is the only part a test cannot produce. Every claim
        // below it, including the hosted domain, is checked for real.
        verifyIdToken: async () => true,
      },
    },
  };
}

export async function createTestAuth(
  options: TestAuthOptions = {},
): Promise<{ auth: Auth; database: Database; config: AuthConfig }> {
  const baseURL = options.baseURL ?? TEST_BASE_URL;
  const config: AuthConfig = {
    appName: "Test App",
    baseURL,
    secret: "test-secret-test-secret-test-secret",
    cookiePrefix: "portego",
    useSecureCookies: false,
    providers: options.providers ?? [googleTestProvider(options.hostedDomain)],
    admission: options.allowAll
      ? { kind: "all-authenticated" }
      : { kind: "email-domains", domains: options.domains ?? ["acme.example"] },
    mcp: {
      resource: `${baseURL}/mcp`,
      loginPage: "/mcp/login",
      consentPage: "/mcp/consent",
      allowDynamicClientRegistration: false,
    },
  };

  const database = options.database ?? new Database(":memory:");
  const auth = createAuth({ config, database });
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
  return { auth, database, config };
}

/** Signs in through the test provider. Returns the raw response. */
export function signIn(auth: Auth, claims: TestClaims): Promise<Response> {
  return auth.handler(
    new Request(`${TEST_BASE_URL}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: TEST_BASE_URL },
      body: JSON.stringify({ provider: "google", idToken: { token: idToken(claims) } }),
    }),
  );
}
