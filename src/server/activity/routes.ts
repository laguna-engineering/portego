import { Hono } from "hono";
import { type AppEnv, currentUser, requireUser } from "../auth/middleware.ts";
import type { ActivityStore } from "../storage/activity.ts";

/** How far back the feed reaches. Nothing is deleted; older activity is just not listed. */
export const ACTIVITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** The feed is a menu, not an archive. A busy week shows its most recent part. */
export const ACTIVITY_LIMIT = 100;

export function activityRoutes(store: ActivityStore, options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const routes = new Hono<AppEnv>();
  routes.use("*", requireUser);

  routes.get("/", (c) => {
    const userId = currentUser(c).id;
    return c.json({
      items: store.list({ since: now() - ACTIVITY_WINDOW_MS, limit: ACTIVITY_LIMIT, userId }),
      readAt: store.readAt(userId),
    });
  });

  routes.post("/read", (c) => c.json({ readAt: store.markRead(currentUser(c).id, now()) }));

  return routes;
}
