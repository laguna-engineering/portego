import type { Database } from "bun:sqlite";
import { VISIBLE } from "./artifacts.ts";
import { JOIN_DISPLAY_NAME, USER_NAME } from "./names.ts";

export type Avatar = { contentType: string; bytes: Uint8Array<ArrayBuffer>; updatedAt: number };

/** When each of the user's own actions happened, in epoch ms, oldest first. */
export type ProfileActivity = {
  uploads: number[];
  versions: number[];
  comments: number[];
};

export type HistoryKind = "created" | "updated" | "commented";

export const HISTORY_KINDS: readonly HistoryKind[] = ["created", "updated", "commented"];

/** One thing a user did, on an artifact the viewer can open. */
export type HistoryEntry = {
  /** The id of the version or comment. */
  id: string;
  kind: HistoryKind;
  /** Set when `kind` is `updated`. */
  versionNumber: number | null;
  createdAt: number;
  artifact: { id: string; title: string; filename: string };
};

export type Person = { id: string; name: string; joinedAt: number };

export type ProfileStore = {
  avatar: (userId: string) => Avatar | null;
  /** When the avatar last changed, or null if the user has none. */
  avatarUpdatedAt: (userId: string) => number | null;
  setAvatar: (userId: string, avatar: Avatar) => void;
  removeAvatar: (userId: string) => void;
  /** Everything the user did since `since` (epoch ms), on any artifact. */
  activity: (userId: string, since: number) => ProfileActivity;
  /** The name the user chose, or null to show the one sign-in recorded. */
  displayName: (userId: string) => string | null;
  setDisplayName: (userId: string, name: string | null) => void;
  person: (userId: string) => Person | null;
  /**
   * What the user did, newest first, leaving out artifacts `viewerId` cannot
   * open. `total` counts every matching entry, not only this page.
   */
  history: (options: {
    userId: string;
    viewerId: string;
    kind: HistoryKind | null;
    offset: number;
    limit: number;
  }) => { entries: HistoryEntry[]; total: number };
  /** How many artifacts the viewer can open that the user uploaded to or commented on. */
  artifactCount: (userId: string, viewerId: string) => number;
};

// Version 1 is the upload that created the artifact.
const HISTORY = `
  select history.*, artifacts.title as artifactTitle,
    (select originalFilename from artifactVersions current
      where current.artifactId = artifacts.id order by number desc limit 1) as filename
  from (
    select id, createdAt, artifactId, case when number = 1 then 'created' else 'updated' end as kind,
      number as versionNumber
    from artifactVersions where createdBy = ?
    union all
    select id, createdAt, artifactId, 'commented', null
    from artifactComments where authorId = ?
  ) history
    join artifacts on artifacts.id = history.artifactId
  where ${VISIBLE} and (? is null or history.kind = ?)`;

type HistoryRow = {
  id: string;
  createdAt: number;
  artifactId: string;
  kind: HistoryKind;
  versionNumber: number;
  artifactTitle: string;
  filename: string;
};

export function createProfileStore(options: { database: Database }): ProfileStore {
  const { database } = options;

  return {
    avatar(userId) {
      const row = database
        .query("select contentType, bytes, updatedAt from userAvatars where userId = ?")
        .get(userId) as Avatar | null;
      return row ? { ...row, bytes: new Uint8Array(row.bytes) } : null;
    },

    avatarUpdatedAt(userId) {
      const row = database
        .query("select updatedAt from userAvatars where userId = ?")
        .get(userId) as { updatedAt: number } | null;
      return row?.updatedAt ?? null;
    },

    setAvatar(userId, { contentType, bytes, updatedAt }) {
      database
        .query(
          `insert into userAvatars (userId, contentType, bytes, updatedAt) values (?, ?, ?, ?)
           on conflict (userId) do update set
             contentType = excluded.contentType, bytes = excluded.bytes, updatedAt = excluded.updatedAt`,
        )
        .run(userId, contentType, bytes, updatedAt);
    },

    removeAvatar(userId) {
      database.query("delete from userAvatars where userId = ?").run(userId);
    },

    activity(userId, since) {
      // Version 1 is the upload that created the artifact.
      const versions = database
        .query(
          `select number, createdAt from artifactVersions
           where createdBy = ? and createdAt >= ? order by createdAt`,
        )
        .all(userId, since) as { number: number; createdAt: number }[];
      const comments = database
        .query(
          `select createdAt from artifactComments
           where authorId = ? and createdAt >= ? order by createdAt`,
        )
        .all(userId, since) as { createdAt: number }[];
      return {
        uploads: versions.filter((row) => row.number === 1).map((row) => row.createdAt),
        versions: versions.filter((row) => row.number > 1).map((row) => row.createdAt),
        comments: comments.map((row) => row.createdAt),
      };
    },

    displayName(userId) {
      const row = database
        .query("select name from userDisplayNames where userId = ?")
        .get(userId) as { name: string } | null;
      return row?.name ?? null;
    },

    setDisplayName(userId, name) {
      if (name === null) {
        database.query("delete from userDisplayNames where userId = ?").run(userId);
        return;
      }
      database
        .query(
          `insert into userDisplayNames (userId, name) values (?, ?)
           on conflict (userId) do update set name = excluded.name`,
        )
        .run(userId, name);
    },

    person(userId) {
      const row = database
        .query(
          `select "user".id, ${USER_NAME} as name, "user".createdAt from "user" ${JOIN_DISPLAY_NAME}
           where "user".id = ?`,
        )
        .get(userId) as { id: string; name: string; createdAt: string | number } | null;
      if (!row) return null;
      // Better Auth writes an ISO string. Rows inserted directly hold epoch ms.
      const joinedAt =
        typeof row.createdAt === "number" ? row.createdAt : Date.parse(row.createdAt);
      return { id: row.id, name: row.name, joinedAt };
    },

    history({ userId, viewerId, kind, offset, limit }) {
      const params = [userId, userId, viewerId, kind, kind];
      const { total } = database
        .query(`select count(*) as total from (${HISTORY})`)
        .get(...params) as { total: number };
      const rows = database
        .query(`${HISTORY} order by history.createdAt desc, history.id desc limit ? offset ?`)
        .all(...params, limit, offset) as HistoryRow[];
      return {
        total,
        entries: rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          versionNumber: row.kind === "updated" ? row.versionNumber : null,
          createdAt: row.createdAt,
          artifact: { id: row.artifactId, title: row.artifactTitle, filename: row.filename },
        })),
      };
    },

    artifactCount(userId, viewerId) {
      const row = database
        .query(`select count(distinct history.artifactId) as count from (${HISTORY}) history`)
        .get(userId, userId, viewerId, null, null) as { count: number };
      return row.count;
    },
  };
}
