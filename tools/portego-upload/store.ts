/**
 * The credentials file: one token per deployment, and each build's default
 * deployment for when PORTEGO_ORIGIN does not name one. Portego and every
 * company's build of it share the file.
 */

import { type Brand, DEFAULT_BRAND } from "./brand.ts";

export type Token = {
  accessToken: string;
  refreshToken?: string;
  /** Unix seconds. */
  expiresAt: number;
  /** The public key (`x`) of the service key that got this token, if one did. */
  keyId?: string;
};

export type Store = {
  /** Portego's default. */
  defaultOrigin?: string;
  /** A company build's default, by slug. */
  defaultOrigins?: Record<string, string>;
  tokens: Record<string, Token>;
};

type Build = Pick<Brand, "slug" | "origin">;

function ownDefault(store: Store, brand: Build): string | undefined {
  return brand.slug === DEFAULT_BRAND.slug
    ? store.defaultOrigin
    : store.defaultOrigins?.[brand.slug];
}

/** The file as written before it held more than one deployment. */
type SingleOriginFile = Token & { origin: string };

export function normalizeOrigin(origin: string): string {
  return origin.replace(/\/+$/, "");
}

/** Unreadable content is an empty store, which asks for a sign-in. */
export function parseStore(text: string | null): Store {
  if (text === null) return { tokens: {} };
  try {
    const parsed = JSON.parse(text) as Partial<Store> & Partial<SingleOriginFile>;
    if (typeof parsed.origin === "string" && typeof parsed.accessToken === "string") {
      const { origin, ...token } = parsed as SingleOriginFile;
      return { defaultOrigin: origin, tokens: { [origin]: token } };
    }
    return {
      defaultOrigin: parsed.defaultOrigin,
      defaultOrigins: parsed.defaultOrigins,
      tokens: parsed.tokens ?? {},
    };
  } catch {
    return { tokens: {} };
  }
}

/**
 * PORTEGO_ORIGIN wins, so a project can point at another deployment without
 * changing the default that every other project uses. A company's build reads
 * Portego's default only when it has neither its own nor a built-in one: that
 * default can name another company's deployment, and older versions kept the
 * build's own default there.
 */
export function resolveOrigin(sources: {
  env?: string;
  argument?: string;
  store: Store;
  brand: Build;
}): string | undefined {
  const origin =
    sources.env ||
    sources.argument ||
    ownDefault(sources.store, sources.brand) ||
    sources.brand.origin ||
    sources.store.defaultOrigin;
  return origin ? normalizeOrigin(origin) : undefined;
}

/**
 * The first sign-in becomes the default, except in a build with a deployment
 * built in: storing that one would keep people on it after a newer build
 * names another.
 */
export function withToken(
  store: Store,
  origin: string,
  token: Token,
  options: { makeDefault: boolean; brand: Build },
): Store {
  const { brand } = options;
  const current = ownDefault(store, brand);
  const next = options.makeDefault ? origin : (current ?? (brand.origin ? undefined : origin));
  const tokens = { ...store.tokens, [origin]: token };
  if (brand.slug === DEFAULT_BRAND.slug) return { ...store, defaultOrigin: next, tokens };
  if (!next) return { ...store, tokens };
  return { ...store, defaultOrigins: { ...store.defaultOrigins, [brand.slug]: next }, tokens };
}
