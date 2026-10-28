import { Hono } from "hono";
import { ServiceError } from "../artifacts/errors.ts";
import { type AppEnv, currentUser, requireUser } from "../auth/middleware.ts";
import type { EventBus } from "../events/bus.ts";
import type { ActivityStore } from "../storage/activity.ts";
import { SUBSCRIPTION_LEVELS, type SubscriptionLevel } from "../storage/subscriptions.ts";

/** How far back the feed reaches. Nothing is deleted; older activity is just not listed. */
export const ACTIVITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** The feed is a menu, not an archive. A busy week shows its most recent part. */
export const ACTIVITY_LIMIT = 100;

export function activityRoutes(
  store: ActivityStore,
  options: { now?: () => number; events?: EventBus } = {},
) {
  const now = options.now ?? Date.now;
  const publish = options.events?.publish ?? (() => {});
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

  routes.post("/read", (c) => {
    const userId = currentUser(c).id;
    const readAt = store.markRead(userId, now());
    publish({ type: "activity.read", userId });
    return c.json({ readAt });
  });

  routes.post("/read/artifacts/:id", async (c) => {
    const versionNumber = await readField(c.req.raw, "versionNumber");
    if (!Number.isInteger(versionNumber) || (versionNumber as number) < 1) {
      throw new ServiceError("INVALID_INPUT", "Send a versionNumber, a whole number from 1.");
    }
    const userId = currentUser(c).id;
    const seen = store.markVersionsSeen(userId, c.req.param("id"), versionNumber as number);
    if (seen === null) throw new ServiceError("NOT_FOUND", "No such version.");
    publish({ type: "activity.read", userId });
    return c.json({ versionNumber: seen });
  });

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

async function readField(request: Request, name: string): Promise<unknown> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  return (body as Record<string, unknown> | null)?.[name];
}

async function readLevel(request: Request): Promise<SubscriptionLevel> {
  const level = await readField(request, "level");
  if (!SUBSCRIPTION_LEVELS.includes(level as SubscriptionLevel)) {
    throw new ServiceError("INVALID_INPUT", `Send a level: ${SUBSCRIPTION_LEVELS.join(", ")}.`);
  }
  return level as SubscriptionLevel;
}
