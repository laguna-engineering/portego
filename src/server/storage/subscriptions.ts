import type { Database } from "bun:sqlite";
import { VISIBLE } from "./artifacts.ts";

/** What reaches the bell: everything, new versions only, or nothing. */
export type SubscriptionLevel = "all" | "versions" | "none";

/** Why someone follows an artifact: they uploaded to it, commented on it, or picked a level. */
export type FollowReason = "uploaded" | "commented" | "chosen";

export const SUBSCRIPTION_LEVELS: readonly SubscriptionLevel[] = ["all", "versions", "none"];

export type Subscription = {
  /** The level set on this artifact or folder itself. Null when none is. */
  level: SubscriptionLevel | null;
  /** Artifacts only. Null when `level` is. */
  reason: FollowReason | null;
  /** The nearest folder above with a level. It applies when `level` is null. */
  inherited: { folder: { id: string; name: string }; level: SubscriptionLevel } | null;
};

export type SubscriptionStore = {
  /** Null when the artifact does not exist or the user cannot see it. */
  artifact: (userId: string, artifactId: string) => Subscription | null;
  /** Null when the folder does not exist. */
  folder: (userId: string, folderId: string) => Subscription | null;
  setArtifact: (
    userId: string,
    artifactId: string,
    level: SubscriptionLevel,
  ) => Subscription | null;
  setFolder: (userId: string, folderId: string, level: SubscriptionLevel) => Subscription | null;
};

/**
 * Follows an artifact for someone who uploaded to it or commented on it. It
 * brings back someone who had stopped watching. A level they chose stays.
 */
export function follow(
  database: Database,
  input: { userId: string; artifactId: string; reason: "uploaded" | "commented"; at: number },
): void {
  database
    .query(
      `insert into artifactSubscriptions (userId, artifactId, level, reason, updatedAt)
       values (?, ?, 'all', ?, ?)
       on conflict (userId, artifactId) do update
         set level = 'all', reason = excluded.reason, updatedAt = excluded.updatedAt
         where artifactSubscriptions.level = 'none'`,
    )
    .run(input.userId, input.artifactId, input.reason, input.at);
}

// The depth limit only guards against a cycle, which folder moves prevent.
const NEAREST_WATCHED_FOLDER = `
  with recursive up (id, depth) as (
    select ?, 0
    union all
    select folders.parentId, up.depth + 1 from folders join up on folders.id = up.id
    where folders.parentId is not null and up.depth < 100
  )
  select folders.id, folders.name, folderSubscriptions.level
  from up
    join folderSubscriptions on folderSubscriptions.folderId = up.id
      and folderSubscriptions.userId = ?
    join folders on folders.id = up.id
  order by up.depth
  limit 1`;

export function createSubscriptionStore(options: { database: Database }): SubscriptionStore {
  const { database } = options;

  const inherited = (userId: string, folderId: string | null): Subscription["inherited"] => {
    if (folderId === null) return null;
    const row = database.query(NEAREST_WATCHED_FOLDER).get(folderId, userId) as {
      id: string;
      name: string;
      level: SubscriptionLevel;
    } | null;
    return row ? { folder: { id: row.id, name: row.name }, level: row.level } : null;
  };

  const artifact = (userId: string, artifactId: string): Subscription | null => {
    const row = database
      .query(
        `select artifacts.folderId, artifactSubscriptions.level, artifactSubscriptions.reason
         from artifacts
           left join artifactSubscriptions on artifactSubscriptions.artifactId = artifacts.id
             and artifactSubscriptions.userId = ?
         where artifacts.id = ? and ${VISIBLE}`,
      )
      .get(userId, artifactId, userId) as {
      folderId: string | null;
      level: SubscriptionLevel | null;
      reason: FollowReason | null;
    } | null;
    if (!row) return null;
    return { level: row.level, reason: row.reason, inherited: inherited(userId, row.folderId) };
  };

  const folder = (userId: string, folderId: string): Subscription | null => {
    const row = database
      .query(
        `select folders.parentId, folderSubscriptions.level
         from folders
           left join folderSubscriptions on folderSubscriptions.folderId = folders.id
             and folderSubscriptions.userId = ?
         where folders.id = ?`,
      )
      .get(userId, folderId) as { parentId: string | null; level: SubscriptionLevel | null } | null;
    if (!row) return null;
    return { level: row.level, reason: null, inherited: inherited(userId, row.parentId) };
  };

  return {
    artifact,
    folder,

    setArtifact(userId, artifactId, level) {
      if (!artifact(userId, artifactId)) return null;
      database
        .query(
          `insert into artifactSubscriptions (userId, artifactId, level, reason, updatedAt)
           values (?, ?, ?, 'chosen', ?)
           on conflict (userId, artifactId) do update
             set level = excluded.level, reason = 'chosen', updatedAt = excluded.updatedAt`,
        )
        .run(userId, artifactId, level, Date.now());
      return artifact(userId, artifactId);
    },

    setFolder(userId, folderId, level) {
      if (!folder(userId, folderId)) return null;
      database
        .query(
          `insert into folderSubscriptions (userId, folderId, level, updatedAt)
           values (?, ?, ?, ?)
           on conflict (userId, folderId) do update
             set level = excluded.level, updatedAt = excluded.updatedAt`,
        )
        .run(userId, folderId, level, Date.now());
      return folder(userId, folderId);
    },
  };
}
