import type { User } from "better-auth/types";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./middleware.ts";

/** Admins are named by address in PORTEGO_ADMINS, and only a verified address counts. */
export function isAdmin(admins: readonly string[], user: Pick<User, "email" | "emailVerified">) {
  return user.emailVerified === true && admins.includes(user.email.trim().toLowerCase());
}

/** Refuses anyone who is not signed in as an admin. Runs after `attachSession`. */
export function requireAdmin(admins: readonly string[]) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const user = c.get("user");
    if (!user) {
      return c.json({ error: { code: "UNAUTHENTICATED", message: "Sign in to continue." } }, 401);
    }
    if (!isAdmin(admins, user)) {
      return c.json(
        { error: { code: "FORBIDDEN", message: "Only an administrator can do this." } },
        403,
      );
    }
    await next();
  });
}
