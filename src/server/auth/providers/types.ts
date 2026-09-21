import type { EnvSource } from "../../env.ts";

/**
 * One identity provider a deployment can enable. A definition owns its own
 * settings and their validation, so adding a provider does not change the
 * environment schema, the admission policy, or any application route. The
 * provider-specific option type stays inside the provider module: the registry
 * only needs an opaque object to hand to Better Auth.
 */
/**
 * How a provider reaches Better Auth. A social provider is a built-in entry in
 * the `socialProviders` map; an OpenID Connect provider is one entry in the
 * generic OAuth plugin. Both are signed in through the same endpoint, so
 * nothing outside this module has to tell them apart.
 */
export type ProviderWiring = { kind: "social"; options: object } | { kind: "oidc"; config: object };

export type ProviderDefinition = {
  /** Stable id. Also the Better Auth provider key and the callback URL segment. */
  id: string;
  /** Shown on the sign-in page when the deployment configures no other label. */
  defaultLabel: string;
  /**
   * Reads and validates this provider's settings. Names every missing variable
   * so startup can report all of them at once.
   */
  resolve: (
    source: EnvSource,
  ) =>
    | { ok: true; wiring: ProviderWiring; label?: string }
    | { ok: false; missing: readonly string[] };
};
