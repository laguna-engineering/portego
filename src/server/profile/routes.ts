import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ServiceError } from "../artifacts/errors.ts";
import { detectImageType } from "../artifacts/images.ts";
import { type AppEnv, currentUser, requireUser } from "../auth/middleware.ts";
import type { ProfileStore } from "../storage/profiles.ts";

export const AVATAR_MAX_BYTES = 1024 * 1024;

/** 53 weeks, so the graph's first column is covered from its Sunday whatever today is. */
export const PROFILE_ACTIVITY_WINDOW_MS = 53 * 7 * 24 * 60 * 60 * 1000;

/** The URL the client loads the avatar from. It changes with the avatar, so it can be cached. */
export function avatarUrl(store: ProfileStore, userId: string): string | null {
  const updatedAt = store.avatarUpdatedAt(userId);
  return updatedAt === null ? null : `/api/me/avatar?v=${updatedAt}`;
}

export function profileRoutes(store: ProfileStore, options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const routes = new Hono<AppEnv>();
  routes.use("*", requireUser);

  routes.get("/avatar", (c) => {
    const avatar = store.avatar(currentUser(c).id);
    if (!avatar) throw new ServiceError("NOT_FOUND", "You have no avatar.");
    return c.body(avatar.bytes, 200, {
      "content-type": avatar.contentType,
      "x-content-type-options": "nosniff",
      // The bytes are served from the app's own origin, so nothing in them may run.
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, max-age=31536000, immutable",
    });
  });

  routes.put(
    "/avatar",
    bodyLimit({
      maxSize: AVATAR_MAX_BYTES,
      onError: (c) =>
        c.json(
          { error: { code: "FILE_TOO_LARGE", message: "The avatar can be at most 1 MiB." } },
          413,
        ),
    }),
    async (c) => {
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      const type = detectImageType(bytes);
      if (!type) {
        throw new ServiceError(
          "UNSUPPORTED_CONTENT",
          "That file is not an image. Choose a PNG, JPEG, GIF, WebP, or AVIF file.",
        );
      }
      const userId = currentUser(c).id;
      store.setAvatar(userId, { contentType: type.contentType, bytes, updatedAt: now() });
      return c.json({ avatar: avatarUrl(store, userId) });
    },
  );

  routes.delete("/avatar", (c) => {
    store.removeAvatar(currentUser(c).id);
    return c.json({ avatar: null });
  });

  routes.get("/activity", (c) =>
    c.json(store.activity(currentUser(c).id, now() - PROFILE_ACTIVITY_WINDOW_MS)),
  );

  return routes;
}
