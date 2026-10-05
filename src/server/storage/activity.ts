import type { Database } from "bun:sqlite";
import { VISIBLE } from "./artifacts.ts";
import { JOIN_DISPLAY_NAME, USER_NAME } from "./names.ts";

export type StatusChange = "solved" | "reopened" | "archived" | "restored";

/**
 * One thing that happened to an artifact. `id` is the id of the version,
 * comment, change, or entry write.
 */
export type Activity = {
  id: string;
  createdAt: Date;
  actor: { id: string; name: string };
  artifact: { id: string; title: string };
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
   * everything on someone else's private artifact.
   */
  list: (options: { since: number; limit: number; userId: string }) => Activity[];
  /** When the user last opened their notifications. Null if never. */
  readAt: (userId: string) => Date | null;
  /** Moves the user's read marker forward to `at`. It never moves back. */
  markRead: (userId: string, at: number) => Date;
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
};

// Built from the rows that already record each change, so there is nothing
// to keep in step. Version 1 is the upload that created the artifact.
const SELECT_ACTIVITY = `
  select activity.*, artifacts.title as artifactTitle, ${USER_NAME} as actorName
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
  where not (activity.actorId = ? and activity.inApp = 1) and ${VISIBLE}
  order by activity.createdAt desc, activity.id desc
  limit ?`;

function toActivity(row: Row): Activity {
  const base = {
    id: row.id,
    createdAt: new Date(row.createdAt),
    actor: { id: row.actorId, name: row.actorName },
    artifact: { id: row.artifactId, title: row.artifactTitle },
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
    list({ since, limit, userId }) {
      const rows = database
        .query(SELECT_ACTIVITY)
        .all(since, since, since, since, userId, userId, limit) as Row[];
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
  };
}
