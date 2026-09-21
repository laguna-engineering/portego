import type { Session, User } from "better-auth/types";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { Auth } from "./auth.ts";

export type AppEnv = {
  Variables: {
    user: User | null;
    session: Session | null;
  };
};

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Reads the session cookie once per request. Routes then decide what an absent
 * session means, instead of each one parsing cookies again.
 */
export function attachSession(auth: Auth) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const result = await auth.api.getSession({ headers: c.req.raw.headers });
    c.set("user", result?.user ?? null);
    c.set("session", result?.session ?? null);
    await next();
  });
}

/** The signed-in user. Only valid on a route that runs after `requireUser`. */
export function currentUser(c: Context<AppEnv>): User {
  const user = c.get("user");
  if (!user) throw new Error("currentUser was called on an unauthenticated route");
  return user;
}

/** Refuses requests without a session. Reveals nothing about what was asked for. */
export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.get("user")) {
    return c.json({ error: { code: "UNAUTHENTICATED", message: "Sign in to continue." } }, 401);
  }
  await next();
});

/**
 * CSRF defence for cookie-authenticated mutations: a cross-site form or fetch
 * can send the cookie, but it cannot forge the Origin header. Requests without
 * a cookie carry no ambient authority and are left alone, so a bearer-token
 * client is unaffected.
 */
export function requireSameOrigin(baseURL: string) {
  const expected = new URL(baseURL).origin;
  return createMiddleware<AppEnv>(async (c, next) => {
    const method = c.req.method.toUpperCase();
    if (MUTATING_METHODS.has(method) && c.req.header("cookie")) {
      const origin = c.req.header("origin");
      if (origin !== expected) {
        return c.json(
          { error: { code: "INVALID_ORIGIN", message: "The request origin is not allowed." } },
          403,
        );
      }
    }
    await next();
  });
}
