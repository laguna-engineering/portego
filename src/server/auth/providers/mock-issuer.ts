/**
 * A local OpenID Connect issuer for tests. It signs real id tokens with a real
 * key, so the provider code verifies signature, issuer, audience, expiry, and
 * nonce exactly as it would against a live identity service. No test reaches a
 * public identity provider.
 */
import { exportJWK, generateKeyPair, SignJWT } from "jose";

export type IssuedClaims = {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  /** Overrides the audience, for testing a token minted for another client. */
  aud?: string;
  /** Overrides the issuer, for testing a token from somewhere else. */
  iss?: string;
  /** Overrides the nonce, for testing a replayed token. */
  nonce?: string;
};

export type MockIssuer = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Claims the next token exchange returns. */
  issue: (claims: IssuedClaims) => void;
  /** Signs the next id token with a key the published JWKS does not contain. */
  signWithForeignKey: (enabled: boolean) => void;
  /** Serves a discovery document that is not usable. */
  breakDiscovery: (enabled: boolean) => void;
  tokenRequests: number;
  stop: () => void;
};

export type MockIssuerOptions = {
  /** A fixed port, for a development issuer that `.env` points at. */
  port?: number;
};

export async function startMockIssuer(options: MockIssuerOptions = {}): Promise<MockIssuer> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const foreign = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256", use: "sig" };

  const state = {
    claims: { sub: "subject-1", email: "person@acme.example", email_verified: true },
    foreignKey: false,
    brokenDiscovery: false,
    nonce: undefined as string | undefined,
    tokenRequests: 0,
  };

  // The issuer is its own base URL, which is only known once the port is
  // assigned, so it is filled in right after the listener starts.
  let issuer = "";

  const server = Bun.serve({
    port: options.port ?? 0,
    hostname: "127.0.0.1",
    fetch: async (request): Promise<Response> => {
      const url = new URL(request.url);

      if (url.pathname === "/.well-known/openid-configuration") {
        if (state.brokenDiscovery) return new Response("not json", { status: 200 });
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          userinfo_endpoint: `${issuer}/userinfo`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          code_challenge_methods_supported: ["S256"],
          scopes_supported: ["openid", "profile", "email"],
        });
      }

      if (url.pathname === "/jwks") return Response.json({ keys: [jwk] });

      // A browser is sent here by the application. There is nobody to ask, so
      // it goes straight back with a code. Tests never take this path.
      if (url.pathname === "/authorize") {
        const back = url.searchParams.get("redirect_uri");
        if (!back) return new Response("redirect_uri is required", { status: 400 });
        state.nonce = url.searchParams.get("nonce") ?? undefined;
        const target = new URL(back);
        target.searchParams.set("code", "mock-code");
        const requestState = url.searchParams.get("state");
        if (requestState) target.searchParams.set("state", requestState);
        return Response.redirect(target.toString(), 302);
      }

      if (url.pathname === "/token") {
        state.tokenRequests += 1;
        const claims = state.claims as IssuedClaims;
        const idToken = await new SignJWT({
          email: claims.email,
          email_verified: claims.email_verified,
          name: claims.name ?? "A Person",
          ...((claims.nonce ?? state.nonce) ? { nonce: claims.nonce ?? state.nonce } : {}),
        })
          .setProtectedHeader({ alg: "RS256", kid: "test-key" })
          .setIssuer(claims.iss ?? issuer)
          .setSubject(claims.sub)
          .setAudience(claims.aud ?? "test-client-id")
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(state.foreignKey ? foreign.privateKey : privateKey);

        return Response.json({
          access_token: "mock-access-token",
          id_token: idToken,
          token_type: "Bearer",
          expires_in: 300,
        });
      }

      if (url.pathname === "/userinfo") return Response.json({ ...state.claims });

      return new Response("not found", { status: 404 });
    },
  });

  issuer = `http://127.0.0.1:${server.port}`;

  return {
    issuer,
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    issue(claims) {
      state.claims = { ...state.claims, ...claims };
    },
    signWithForeignKey(enabled) {
      state.foreignKey = enabled;
    },
    breakDiscovery(enabled) {
      state.brokenDiscovery = enabled;
    },
    get tokenRequests() {
      return state.tokenRequests;
    },
    stop() {
      server.stop(true);
    },
  };
}

/** The nonce the authorization URL carried, so the id token can echo it. */
export function readNonce(authorizationUrl: string): string | undefined {
  return new URL(authorizationUrl).searchParams.get("nonce") ?? undefined;
}
