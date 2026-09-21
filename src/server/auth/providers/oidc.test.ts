import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestServer, type TestServer } from "../../testing.ts";
import { googleTestProvider, signIn as signInWithGoogle } from "../testing.ts";
import { resolveProviders } from "./index.ts";
import { type MockIssuer, readNonce, startMockIssuer } from "./mock-issuer.ts";
import { buildOidcConfig, discoveryUrlFor, readOidcSettings } from "./oidc.ts";

const APP = "http://localhost:5173";

let mock: MockIssuer;
let server: TestServer;

function oidcProviders(overrides: Record<string, string> = {}) {
  const resolved = resolveProviders(["oidc"], {
    OIDC_ISSUER_URL: mock.issuer,
    OIDC_CLIENT_ID: mock.clientId,
    OIDC_CLIENT_SECRET: mock.clientSecret,
    OIDC_LABEL: "Example SSO",
    ...overrides,
  });
  expect(resolved.errors).toEqual([]);
  return resolved.providers;
}

/** Runs the browser flow: start sign-in, then return through the callback. */
async function signInWithOidc(claims: Parameters<MockIssuer["issue"]>[0]) {
  const start = await server.app.request(`${APP}/api/auth/sign-in/social`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP },
    body: JSON.stringify({ provider: "oidc", callbackURL: "/" }),
  });
  const body = (await start.json()) as { url?: string };
  if (!body.url) return { authorizationUrl: null, response: start };

  const authorization = new URL(body.url);
  mock.issue({ ...claims, nonce: claims.nonce ?? readNonce(body.url) });

  const cookie = (start.headers.get("set-cookie") ?? "")
    .split(/,(?=[^;]+=)/)
    .map((entry) => entry.split(";")[0])
    .join("; ");

  const response = await server.app.request(
    `${APP}/api/auth/callback/oidc?code=mock-code&state=${encodeURIComponent(
      authorization.searchParams.get("state") ?? "",
    )}`,
    { redirect: "manual", headers: { cookie } },
  );
  return { authorizationUrl: authorization, response };
}

function sessionCookie(response: Response): string {
  return (
    (response.headers.get("set-cookie") ?? "")
      .split(/,(?=[^;]+=)/)
      .map((entry) => entry.trim())
      .find((entry) => entry.startsWith("portego.session_token=") && !entry.includes("Max-Age=0"))
      ?.split(";")[0] ?? ""
  );
}

beforeEach(async () => {
  mock = await startMockIssuer();
  server = await createTestServer({ providers: oidcProviders() });
  // The provider reads the issuer's discovery document when the auth context
  // starts. Waiting for that here keeps the fetch inside the test's lifetime.
  await server.auth.$context;
});

afterEach(() => {
  server.cleanup();
  mock.stop();
});

describe("signing in", () => {
  test("admits an identity the issuer verified", async () => {
    const { response } = await signInWithOidc({
      sub: "subject-1",
      email: "person@acme.example",
      email_verified: true,
    });

    expect(response.status).toBe(302);
    expect(sessionCookie(response)).not.toBe("");

    const session = await server.auth.api.getSession({
      headers: new Headers({ cookie: sessionCookie(response) }),
    });
    expect(session?.user.email).toBe("person@acme.example");
  });

  test("stores the provider and its stable subject as the identity", async () => {
    await signInWithOidc({
      sub: "subject-1",
      email: "person@acme.example",
      email_verified: true,
    });

    const account = server.database.query("select providerId, accountId from account").get() as {
      providerId: string;
      accountId: string;
    };
    expect(account).toEqual({ providerId: "oidc", accountId: "subject-1" });
  });

  test("asks for a code with PKCE and a nonce, which the issuer must echo", async () => {
    const { authorizationUrl } = await signInWithOidc({
      sub: "subject-1",
      email: "person@acme.example",
      email_verified: true,
    });

    expect(authorizationUrl?.searchParams.get("response_type")).toBe("code");
    expect(authorizationUrl?.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizationUrl?.searchParams.get("code_challenge")).toBeTruthy();
    expect(authorizationUrl?.searchParams.get("nonce")).toBeTruthy();
    expect(authorizationUrl?.searchParams.get("redirect_uri")).toBe(
      `${APP}/api/auth/callback/oidc`,
    );
  });

  test("applies the same admission policy as any other provider", async () => {
    const { response } = await signInWithOidc({
      sub: "subject-2",
      email: "person@gmail.com",
      email_verified: true,
    });

    expect(sessionCookie(response)).toBe("");
    expect(
      (server.database.query("select count(*) as count from user").get() as { count: number })
        .count,
    ).toBe(0);
  });

  test("refuses an identity the issuer did not report as verified", async () => {
    const { response } = await signInWithOidc({
      sub: "subject-3",
      email: "person@acme.example",
      email_verified: false,
    });

    expect(sessionCookie(response)).toBe("");
  });
});

describe("failing safely", () => {
  test("refuses an id token signed by a key the issuer does not publish", async () => {
    mock.signWithForeignKey(true);
    const { response } = await signInWithOidc({
      sub: "subject-1",
      email: "person@acme.example",
      email_verified: true,
    });

    expect(sessionCookie(response)).toBe("");
    expect(
      (server.database.query("select count(*) as count from user").get() as { count: number })
        .count,
    ).toBe(0);
  });

  test("refuses an id token minted for another client", async () => {
    const { response } = await signInWithOidc({
      sub: "subject-1",
      email: "person@acme.example",
      email_verified: true,
      aud: "another-client",
    });
    expect(sessionCookie(response)).toBe("");
  });

  test("refuses an id token from another issuer", async () => {
    const { response } = await signInWithOidc({
      sub: "subject-1",
      email: "person@acme.example",
      email_verified: true,
      iss: "https://issuer.example",
    });
    expect(sessionCookie(response)).toBe("");
  });

  test("refuses an id token carrying a nonce from another sign-in attempt", async () => {
    const { response } = await signInWithOidc({
      sub: "subject-1",
      email: "person@acme.example",
      email_verified: true,
      nonce: "a-nonce-from-somewhere-else",
    });
    expect(sessionCookie(response)).toBe("");
  });

  test("refuses to come up when the issuer's discovery document is not usable", async () => {
    // The document is read when the provider starts. A deployment pointed at
    // an issuer it cannot read fails there, rather than at the first sign-in.
    mock.breakDiscovery(true);
    const broken = await createTestServer({ providers: oidcProviders() });

    try {
      await expect(broken.auth.$context).rejects.toThrow(/oidc/);
    } finally {
      broken.cleanup();
    }
  });
});

describe("running beside another provider", () => {
  test("keeps one account per person, with an identity per provider", async () => {
    const both = await createTestServer({
      providers: [googleTestProvider(), ...oidcProviders()],
    });
    await both.auth.$context;
    const previous = server;
    server = both;

    try {
      const google = await signInWithGoogle(both.auth, {
        sub: "google-subject-1",
        email: "person@acme.example",
        email_verified: true,
      });
      expect(google.status).toBe(200);

      await signInWithOidc({
        sub: "oidc-subject-1",
        email: "person@acme.example",
        email_verified: true,
      });

      const users = both.database.query("select count(*) as count from user").get() as {
        count: number;
      };
      const accounts = both.database
        .query("select providerId, accountId from account order by providerId")
        .all() as { providerId: string; accountId: string }[];

      // One person, two proofs of who they are.
      expect(users.count).toBe(1);
      expect(accounts).toEqual([
        { providerId: "google", accountId: "google-subject-1" },
        { providerId: "oidc", accountId: "oidc-subject-1" },
      ]);
    } finally {
      server = previous;
      both.cleanup();
    }
  });

  test("offers both providers to the sign-in page, each with its own label", async () => {
    const both = await createTestServer({
      providers: [googleTestProvider(), ...oidcProviders()],
    });
    await both.auth.$context;
    try {
      const res = await both.app.request(`${APP}/api/auth-providers`);
      await expect(res.json()).resolves.toEqual({
        providers: [
          { id: "google", label: "Google" },
          { id: "oidc", label: "Example SSO" },
        ],
      });
    } finally {
      both.cleanup();
    }
  });
});

describe("configuration", () => {
  test("accepts an issuer URL or a discovery URL", () => {
    expect(discoveryUrlFor("https://sso.example")).toBe(
      "https://sso.example/.well-known/openid-configuration",
    );
    expect(discoveryUrlFor("https://sso.example/.well-known/openid-configuration")).toBe(
      "https://sso.example/.well-known/openid-configuration",
    );
  });

  test("refuses an issuer that is not https, so credentials cannot travel in clear", () => {
    expect(discoveryUrlFor("http://sso.example")).toBeNull();
    expect(discoveryUrlFor("not a url")).toBeNull();
  });

  test("names every missing setting at once", () => {
    expect(readOidcSettings({})).toEqual({
      ok: false,
      missing: ["OIDC_ISSUER_URL", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET"],
    });
  });

  test("uses the standard scopes unless the deployment names others", () => {
    const base = {
      OIDC_ISSUER_URL: "https://sso.example",
      OIDC_CLIENT_ID: "a",
      OIDC_CLIENT_SECRET: "b",
    };
    const standard = readOidcSettings(base);
    expect(standard.ok && standard.settings.scopes).toEqual(["openid", "profile", "email"]);

    const custom = readOidcSettings({ ...base, OIDC_SCOPES: "openid email groups" });
    expect(custom.ok && custom.settings.scopes).toEqual(["openid", "email", "groups"]);
  });

  test("requires PKCE and id token verification, whatever the issuer offers", () => {
    const config = buildOidcConfig({
      discoveryUrl: "https://sso.example/.well-known/openid-configuration",
      clientId: "a",
      clientSecret: "b",
      scopes: ["openid"],
      label: "Example SSO",
    });
    expect(config.pkce).toBe(true);
    expect(config.requireIdTokenVerification).toBe(true);
  });

  test("shows the label the deployment configured, and no secrets", () => {
    const providers = oidcProviders();
    expect(providers[0]?.label).toBe("Example SSO");
    expect(JSON.stringify(providers.map(({ id, label }) => ({ id, label })))).not.toContain(
      "test-client-secret",
    );
  });
});

describe("the local issuer's authorization endpoint", () => {
  // Development signs in through a browser, which the issuer must send
  // straight back with a code and the state the application gave it. The
  // nonce it saw has to come back in the id token, or the provider rejects it.
  test("sends the browser back with a code, the state, and the nonce", async () => {
    const authorize = new URL(`${mock.issuer}/authorize`);
    authorize.searchParams.set("redirect_uri", "http://localhost:5173/api/auth/callback/oidc");
    authorize.searchParams.set("state", "state-1");
    authorize.searchParams.set("nonce", "nonce-1");

    const response = await fetch(authorize, { redirect: "manual" });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(
      "http://localhost:5173/api/auth/callback/oidc",
    );
    expect(location.searchParams.get("code")).toBe("mock-code");
    expect(location.searchParams.get("state")).toBe("state-1");

    const token = (await (await fetch(`${mock.issuer}/token`, { method: "POST" })).json()) as {
      id_token: string;
    };
    const payload = JSON.parse(atob(token.id_token.split(".")[1] ?? "")) as { nonce?: string };
    expect(payload.nonce).toBe("nonce-1");
  });

  test("refuses a request with nowhere to go back to", async () => {
    const response = await fetch(`${mock.issuer}/authorize`, { redirect: "manual" });
    expect(response.status).toBe(400);
  });
});
