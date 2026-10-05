import { Hono } from "hono";
import { ServiceError } from "../artifacts/errors.ts";
import { type AppEnv, currentUser, requireUser } from "../auth/middleware.ts";
import type { ActivityStore } from "../storage/activity.ts";
import { SUBSCRIPTION_LEVELS, type SubscriptionLevel } from "../storage/subscriptions.ts";

/** How far back the feed reaches. Nothing is deleted; older activity is just not listed. */
export const ACTIVITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** The feed is a menu, not an archive. A busy week shows its most recent part. */
export const ACTIVITY_LIMIT = 100;

export function activityRoutes(store: ActivityStore, options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const routes = new Hono<AppEnv>();
  routes.use("*", requireUser);

  // The read marker counts what reaches the bell. "everyone" is for browsing.
  routes.get("/", (c) => {
    const userId = currentUser(c).id;
    const scope = c.req.query("scope") === "everyone" ? "everyone" : "following";
    return c.json({
      items: store.list({
        since: now() - ACTIVITY_WINDOW_MS,
        limit: ACTIVITY_LIMIT,
        userId,
        scope,
      }),
      readAt: store.readAt(userId),
    });
  });

  routes.post("/read", (c) => c.json({ readAt: store.markRead(currentUser(c).id, now()) }));

  const { subscriptions } = store;

  routes.get("/subscriptions/artifacts/:id", (c) =>
    c.json({ subscription: found(subscriptions.artifact(currentUser(c).id, c.req.param("id"))) }),
  );

  routes.put("/subscriptions/artifacts/:id", async (c) => {
    const level = await readLevel(c.req.raw);
    const subscription = subscriptions.setArtifact(currentUser(c).id, c.req.param("id"), level);
    return c.json({ subscription: found(subscription) });
  });

  routes.get("/subscriptions/folders/:id", (c) =>
    c.json({ subscription: found(subscriptions.folder(currentUser(c).id, c.req.param("id"))) }),
  );

  routes.put("/subscriptions/folders/:id", async (c) => {
    const level = await readLevel(c.req.raw);
    const subscription = subscriptions.setFolder(currentUser(c).id, c.req.param("id"), level);
    return c.json({ subscription: found(subscription) });
  });

  return routes;
}

function found<T>(value: T | null): T {
  if (value === null) throw new ServiceError("NOT_FOUND", "Nothing to follow here.");
  return value;
}

async function readLevel(request: Request): Promise<SubscriptionLevel> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const level = (body as { level?: unknown } | null)?.level;
  if (!SUBSCRIPTION_LEVELS.includes(level as SubscriptionLevel)) {
    throw new ServiceError("INVALID_INPUT", `Send a level: ${SUBSCRIPTION_LEVELS.join(", ")}.`);
  }
  return level as SubscriptionLevel;
}
