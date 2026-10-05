import type { Database } from "bun:sqlite";
import { VISIBLE } from "./artifacts.ts";
import { JOIN_DISPLAY_NAME, USER_NAME } from "./names.ts";
import {
  createSubscriptionStore,
  type FollowReason,
  type SubscriptionLevel,
  type SubscriptionStore,
} from "./subscriptions.ts";

export type StatusChange = "solved" | "reopened" | "archived" | "restored";

/** Why an item reaches the user's bell. */
export type ActivityReason =
  | { kind: FollowReason }
  | { kind: "folder"; folder: { id: string; name: string } }
  /** A reply to the user's comment, which reaches them whatever they follow. */
  | { kind: "reply" };

/**
 * One thing that happened to an artifact. `id` is the id of the version,
 * comment, change, or entry write.
 */
export type Activity = {
  id: string;
  createdAt: Date;
  actor: { id: string; name: string };
  artifact: { id: string; title: string };
  /** Null when the item does not reach the user's bell. */
  reason: ActivityReason | null;
} & (
  | { kind: "artifact.created" }
  | { kind: "version.created"; versionNumber: number }
  | { kind: "comment.created"; reply: boolean }
  | { kind: "status.changed"; change: StatusChange }
  | { kind: "entry.changed"; key: string }
);

export type ActivityStore = {
  /**
   * Everything since `since` (epoch ms), newest first, at most `limit` items.
   * What `userId` did in the web app is left out: they were there. So is
   * everything on someone else's private artifact. "following" keeps only
   * what reaches the user's bell.
   */
  list: (options: {
    since: number;
    limit: number;
    userId: string;
    scope: "following" | "everyone";
  }) => Activity[];
  /** When the user last opened their notifications. Null if never. */
  readAt: (userId: string) => Date | null;
  /** Moves the user's read marker forward to `at`. It never moves back. */
  markRead: (userId: string, at: number) => Date;
  subscriptions: SubscriptionStore;
};

type Row = {
  source: "version" | "comment" | "status" | "entry";
  id: string;
  createdAt: number;
  actorId: string;
  actorName: string;
  artifactId: string;
  artifactTitle: string;
  versionNumber: number | null;
  parentId: string | null;
  change: StatusChange | null;
  entryKey: string | null;
  ownLevel: SubscriptionLevel | null;
  ownReason: FollowReason | null;
  viaFolderId: string | null;
  viaFolderName: string | null;
  byLevel: 0 | 1;
  replyToViewer: 0 | 1;
};

// Built from the rows that already record each change, so there is nothing
// to keep in step. Version 1 is the upload that created the artifact.
//
// `watched` holds every folder a folder subscription reaches, with the level
// and the folder it came from. A folder with its own level stops its parent's.
// The level on an artifact wins over its folder's.
const SELECT_ACTIVITY = `
  with recursive watched (folderId, level, viaId) as (
    select folderId, level, folderId from folderSubscriptions where userId = ?
    union
    select folders.id, watched.level, watched.viaId
    from folders join watched on folders.parentId = watched.folderId
    where folders.id not in (select folderId from folderSubscriptions where userId = ?)
  )
  select * from (
    select activity.*, artifacts.title as artifactTitle, ${USER_NAME} as actorName,
      artifactSubscriptions.level as ownLevel, artifactSubscriptions.reason as ownReason,
      via.id as viaFolderId, via.name as viaFolderName,
      case coalesce(artifactSubscriptions.level, watched.level)
        when 'all' then 1
        when 'versions' then activity.source = 'version'
        else 0
      end as byLevel,
      coalesce(parentComment.authorId = ?, 0) as replyToViewer
    from (
      select 'version' as source, id, createdAt, createdBy as actorId, artifactId, inApp,
        number as versionNumber, null as parentId, null as change, null as entryKey
      from artifactVersions where createdAt >= ?
      union all
      select 'comment', id, createdAt, authorId, artifactId, inApp, null, parentId, null, null
      from artifactComments where createdAt >= ?
      union all
      select 'status', id, createdAt, actorId, artifactId, inApp, null, null, change, null
      from artifactStatusChanges where createdAt >= ?
      union all
      select 'entry', activityId, notifiedAt, authorId, artifactId, inApp, null, null, null, key
      from artifactEntries where notifiedAt >= ?
    ) activity
      join artifacts on artifacts.id = activity.artifactId
      join "user" on "user".id = activity.actorId
      ${JOIN_DISPLAY_NAME}
      left join artifactSubscriptions on artifactSubscriptions.artifactId = activity.artifactId
        and artifactSubscriptions.userId = ?
      left join watched on watched.folderId = artifacts.folderId
      left join folders via on via.id = watched.viaId
      left join artifactComments parentComment on parentComment.id = activity.parentId
    where not (activity.actorId = ? and activity.inApp = 1) and ${VISIBLE}
  ) feed
  where ? or feed.byLevel or feed.replyToViewer
  order by feed.createdAt desc, feed.id desc
  limit ?`;

function reasonOf(row: Row): ActivityReason | null {
  if (row.byLevel) {
    if (row.ownReason) return { kind: row.ownReason };
    return {
      kind: "folder",
      folder: { id: row.viaFolderId as string, name: row.viaFolderName as string },
    };
  }
  return row.replyToViewer ? { kind: "reply" } : null;
}

function toActivity(row: Row): Activity {
  const base = {
    id: row.id,
    createdAt: new Date(row.createdAt),
    actor: { id: row.actorId, name: row.actorName },
    artifact: { id: row.artifactId, title: row.artifactTitle },
    reason: reasonOf(row),
  };
  if (row.source === "comment") {
    return { ...base, kind: "comment.created", reply: row.parentId !== null };
  }
  if (row.source === "status") {
    return { ...base, kind: "status.changed", change: row.change as StatusChange };
  }
  if (row.source === "entry")
    return { ...base, kind: "entry.changed", key: row.entryKey as string };
  if (row.versionNumber === 1) return { ...base, kind: "artifact.created" };
  return { ...base, kind: "version.created", versionNumber: row.versionNumber as number };
}

export function createActivityStore(options: { database: Database }): ActivityStore {
  const { database } = options;

  const readAt = (userId: string): Date | null => {
    const row = database.query("select readAt from activityReads where userId = ?").get(userId) as {
      readAt: number;
    } | null;
    return row ? new Date(row.readAt) : null;
  };

  return {
    list({ since, limit, userId, scope }) {
      const rows = database
        .query(SELECT_ACTIVITY)
        .all(
          userId,
          userId,
          userId,
          since,
          since,
          since,
          since,
          userId,
          userId,
          userId,
          scope === "everyone" ? 1 : 0,
          limit,
        ) as Row[];
      return rows.map(toActivity);
    },

    readAt,

    markRead(userId, at) {
      database
        .query(
          `insert into activityReads (userId, readAt) values (?, ?)
           on conflict (userId) do update set readAt = max(readAt, excluded.readAt)`,
        )
        .run(userId, at);
      return readAt(userId) as Date;
    },

    subscriptions: createSubscriptionStore({ database }),
  };
}
