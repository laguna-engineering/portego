import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ServiceError } from "../artifacts/errors.ts";
import { detectImageType } from "../artifacts/images.ts";
import { readJson } from "../artifacts/routes.ts";
import { type AppEnv, currentUser, requireUser } from "../auth/middleware.ts";
import { HISTORY_KINDS, type HistoryKind, type ProfileStore } from "../storage/profiles.ts";

export const AVATAR_MAX_BYTES = 1024 * 1024;

/** 53 weeks, so the graph's first column is covered from its Sunday whatever today is. */
export const PROFILE_ACTIVITY_WINDOW_MS = 53 * 7 * 24 * 60 * 60 * 1000;

/** The URL the client loads the avatar from. It changes with the avatar, so it can be cached. */
export function avatarUrl(store: ProfileStore, userId: string): string | null {
  const updatedAt = store.avatarUpdatedAt(userId);
  return updatedAt === null ? null : `/api/me/avatar?v=${updatedAt}`;
}

export const HISTORY_PAGE_SIZE = 10;

export const DISPLAY_NAME_MAX_LENGTH = 80;

/** Trimmed, with runs of whitespace made one space. An empty name means the one sign-in recorded. */
export function readDisplayName(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new ServiceError("INVALID_INPUT", "The display name must be text, or null to reset it.");
  }
  // A control character would let a name break the lines it is shown in.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point.
  if (/[\u0000-\u001f\u007f]/.test(value.replace(/[\t\n\r]/g, " "))) {
    throw new ServiceError("INVALID_INPUT", "The display name cannot contain control characters.");
  }
  const name = value.replace(/\s+/g, " ").trim();
  if (name === "") return null;
  if ([...name].length > DISPLAY_NAME_MAX_LENGTH) {
    throw new ServiceError(
      "INVALID_INPUT",
      `The display name can be at most ${DISPLAY_NAME_MAX_LENGTH} characters.`,
    );
  }
  return name;
}

function serveAvatar(store: ProfileStore, userId: string, missing: string) {
  const avatar = store.avatar(userId);
  if (!avatar) throw new ServiceError("NOT_FOUND", missing);
  return new Response(avatar.bytes, {
    headers: {
      "content-type": avatar.contentType,
      "x-content-type-options": "nosniff",
      // The bytes are served from the app's own origin, so nothing in them may run.
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}

export function profileRoutes(store: ProfileStore, options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const routes = new Hono<AppEnv>();
  routes.use("*", requireUser);

  routes.get("/avatar", (c) => serveAvatar(store, currentUser(c).id, "You have no avatar."));

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

  routes.put("/display-name", async (c) => {
    const body = await readJson(c);
    const user = currentUser(c);
    const displayName = readDisplayName(body.displayName);
    store.setDisplayName(user.id, displayName);
    return c.json({ name: displayName ?? user.name, displayName, defaultName: user.name });
  });

  routes.get("/activity", (c) =>
    c.json(store.activity(currentUser(c).id, now() - PROFILE_ACTIVITY_WINDOW_MS)),
  );

  return routes;
}

/** Any member's profile, as another signed-in member sees it. */
export function userRoutes(store: ProfileStore) {
  const routes = new Hono<AppEnv>();
  routes.use("*", requireUser);

  const person = (id: string) => {
    const found = store.person(id);
    if (!found) throw new ServiceError("NOT_FOUND", "There is no such member.");
    return found;
  };

  routes.get("/:id", (c) => {
    const { id, name, joinedAt } = person(c.req.param("id"));
    const updatedAt = store.avatarUpdatedAt(id);
    return c.json({
      user: {
        id,
        name,
        joinedAt,
        avatar:
          updatedAt === null ? null : `/api/users/${encodeURIComponent(id)}/avatar?v=${updatedAt}`,
      },
      artifactCount: store.artifactCount(id, currentUser(c).id),
    });
  });

  routes.get("/:id/avatar", (c) => {
    const { id } = person(c.req.param("id"));
    return serveAvatar(store, id, "This member has no avatar.");
  });

  routes.get("/:id/activity", (c) => {
    const { id } = person(c.req.param("id"));
    const kindParam = c.req.query("kind");
    const kind = HISTORY_KINDS.includes(kindParam as HistoryKind)
      ? (kindParam as HistoryKind)
      : null;
    const page = Math.max(0, Number.parseInt(c.req.query("page") ?? "0", 10) || 0);
    const { entries, total } = store.history({
      userId: id,
      viewerId: currentUser(c).id,
      kind,
      offset: page * HISTORY_PAGE_SIZE,
      limit: HISTORY_PAGE_SIZE,
    });
    return c.json({ entries, total, pageSize: HISTORY_PAGE_SIZE });
  });

  return routes;
}
