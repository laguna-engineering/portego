import type { Database } from "bun:sqlite";
import { cimd } from "@better-auth/cimd";
import { mcp } from "@better-auth/mcp";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { jwt } from "better-auth/plugins";
import { type GenericOAuthConfig, genericOAuth } from "better-auth/plugins/generic-oauth";
import type { BetterAuthOptions, BetterAuthPlugin } from "better-auth/types";
import { fetchClientMetadataResource } from "./client-metadata.ts";
import { type AuthConfig, MCP_SCOPES, REFRESH_SCOPE } from "./config.ts";
import { admits, type Identity } from "./policy.ts";

const SESSION_LIFETIME_SECONDS = 60 * 60 * 24 * 7;
// Each refresh rotates the token and restarts this lifetime, so it measures inactivity.
const REFRESH_TOKEN_LIFETIME_SECONDS = 60 * 60 * 24 * 7;

export type CreateAuthOptions = {
  config: AuthConfig;
  database: Database;
};

export type Auth = ReturnType<typeof createAuth>;

/**
 * Fails startup when a configured provider did not register.
 *
 * Better Auth logs and skips a generic OAuth provider whose discovery document
 * it cannot read, and the server then comes up with that provider missing from
 * the sign-in page. A deployment pointed at an issuer it cannot read has to
 * stop at startup instead, where the operator sees it.
 *
 * Plugin init runs in order and each plugin's context changes are visible to
 * the next, so this has to stay after the generic OAuth plugin in the list.
 */
function requireRegisteredProviders(ids: string[]): BetterAuthPlugin {
  return {
    id: "require-registered-providers",
    init: (ctx) => {
      const registered = new Set(ctx.socialProviders.map((provider) => provider.id));
      const missing = ids.filter((id) => !registered.has(id));
      if (missing.length === 0) return;
      throw new Error(
        `Provider discovery failed, so these providers did not register: ${missing.join(", ")}`,
      );
    },
  };
}

export function createAuth({ config, database }: CreateAuthOptions) {
  const socialProviders = Object.fromEntries(
    config.providers.flatMap((provider) =>
      provider.wiring.kind === "social" ? [[provider.id, provider.wiring.options]] : [],
    ),
  );

  // Every OpenID Connect provider the deployment enabled becomes one entry in
  // the generic OAuth plugin, which registers it beside the built-in providers.
  // Sign-in therefore looks the same from the outside whichever kind it is.
  const oidcProviders = config.providers.flatMap((provider) =>
    provider.wiring.kind === "oidc" ? [provider.wiring.config as GenericOAuthConfig] : [],
  );

  const refuseUnlessAdmitted = (identity: Identity, stage: string) => {
    const decision = admits(config.admission, identity);
    if (decision.admitted) return;
    // The reason names the policy, not the person. It goes to the server log;
    // the browser gets a generic refusal.
    console.warn(`Refused ${stage}: ${decision.reason}`);
    throw new APIError("FORBIDDEN", {
      code: "NOT_ADMITTED",
      message: "This account is not allowed to use this service.",
    });
  };

  return betterAuth({
    appName: config.appName,
    baseURL: config.baseURL,
    secret: config.secret,
    database,
    // Better Auth's own social-provider typing is a union per provider id. The
    // registry keeps each provider's option type inside its own module.
    socialProviders: socialProviders as BetterAuthOptions["socialProviders"],
    emailAndPassword: { enabled: false },
    session: {
      expiresIn: SESSION_LIFETIME_SECONDS,
      updateAge: 60 * 60 * 24,
    },
    advanced: {
      cookiePrefix: config.cookiePrefix,
      useSecureCookies: config.useSecureCookies,
      // No cookie domain: the cookie stays host-only, so the isolated content
      // host never receives it. Better Auth adds the __Secure- prefix when
      // secure cookies are on.
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", path: "/" },
    },
    // Better Auth rejects cookie-authenticated requests whose Origin is not
    // trusted, which is the CSRF defence for its own endpoints.
    trustedOrigins: [config.baseURL],
    plugins: [
      ...(oidcProviders.length > 0
        ? [
            genericOAuth({ config: oidcProviders }),
            requireRegisteredProviders(oidcProviders.map((provider) => provider.providerId)),
          ]
        : []),
      // Signs the access tokens the MCP endpoint verifies, and publishes the
      // JWKS that verification reads.
      jwt(),
      mcp({
        resource: config.mcp.resource,
        loginPage: config.mcp.loginPage,
        consentPage: config.mcp.consentPage,
        scopes: [...MCP_SCOPES, REFRESH_SCOPE],
        clientRegistrationDefaultScopes: [...MCP_SCOPES],
        clientRegistrationAllowedScopes: [...MCP_SCOPES, REFRESH_SCOPE],
        refreshTokenExpiresIn: REFRESH_TOKEN_LIFETIME_SECONDS,
        clientRegistrationRequirePKCE: true,
        allowDynamicClientRegistration: config.mcp.allowDynamicClientRegistration,
      }),
      // Client ID Metadata Documents are how an MCP client registers here.
      cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
    ],
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            refuseUnlessAdmitted(user, "account creation");
          },
        },
      },
      session: {
        // Every session passes the policy again, so revoking a domain locks out
        // accounts that were admitted under the previous configuration.
        create: {
          before: async (session, ctx) => {
            const user = await ctx?.context.internalAdapter.findUserById(session.userId);
            if (!user) {
              throw new APIError("UNAUTHORIZED", {
                code: "USER_NOT_FOUND",
                message: "This account is not allowed to use this service.",
              });
            }
            refuseUnlessAdmitted(user, "session creation");
          },
        },
      },
    },
  });
}
