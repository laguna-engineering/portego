/**
 * The credentials file: one token per deployment, and the deployment to use
 * when PORTEGO_ORIGIN does not name one.
 */

export type Token = {
  accessToken: string;
  refreshToken?: string;
  /** Unix seconds. */
  expiresAt: number;
};

export type Store = {
  defaultOrigin?: string;
  tokens: Record<string, Token>;
};

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
    return { defaultOrigin: parsed.defaultOrigin, tokens: parsed.tokens ?? {} };
  } catch {
    return { tokens: {} };
  }
}

/**
 * PORTEGO_ORIGIN wins, so a project can point at another deployment without
 * changing the default that every other project uses.
 */
export function resolveOrigin(sources: {
  env?: string;
  argument?: string;
  store: Store;
}): string | undefined {
  const origin = sources.env || sources.argument || sources.store.defaultOrigin;
  return origin ? normalizeOrigin(origin) : undefined;
}

export function withToken(
  store: Store,
  origin: string,
  token: Token,
  options: { makeDefault: boolean },
): Store {
  return {
    defaultOrigin: options.makeDefault ? origin : (store.defaultOrigin ?? origin),
    tokens: { ...store.tokens, [origin]: token },
  };
}
