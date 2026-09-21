import type { EnvSource } from "../../env.ts";
import { googleProvider } from "./google.ts";
import { oidcProvider } from "./oidc.ts";
import type { ProviderDefinition, ProviderWiring } from "./types.ts";

export type { ProviderDefinition, ProviderWiring } from "./types.ts";

/** Every provider this build can enable. A deployment picks from these ids. */
export const providerRegistry: readonly ProviderDefinition[] = [googleProvider, oidcProvider];

export const providerIds: readonly string[] = providerRegistry.map((provider) => provider.id);

/** Provider metadata safe to send to the browser. Never includes credentials. */
export type PublicProvider = { id: string; label: string };

export type ResolvedProvider = PublicProvider & { wiring: ProviderWiring };

/**
 * Resolves the enabled provider ids into Better Auth options. Reports every
 * unknown id and every missing credential together, so a misconfigured
 * deployment gets one complete error instead of one per restart.
 */
export function resolveProviders(
  ids: readonly string[],
  source: EnvSource,
): { providers: ResolvedProvider[]; errors: string[] } {
  const providers: ResolvedProvider[] = [];
  const errors: string[] = [];

  for (const id of ids) {
    const definition = providerRegistry.find((provider) => provider.id === id);
    if (!definition) {
      errors.push(`AUTH_PROVIDERS names "${id}", which is not a known provider`);
      continue;
    }
    const resolved = definition.resolve(source);
    if (!resolved.ok) {
      errors.push(`provider "${id}" is enabled but ${resolved.missing.join(" and ")} is not set`);
      continue;
    }
    providers.push({
      id: definition.id,
      label: resolved.label ?? definition.defaultLabel,
      wiring: resolved.wiring,
    });
  }

  return { providers, errors };
}
