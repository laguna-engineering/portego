import type { Database } from "bun:sqlite";

export type Avatar = { contentType: string; bytes: Uint8Array<ArrayBuffer>; updatedAt: number };

/** When each of the user's own actions happened, in epoch ms, oldest first. */
export type ProfileActivity = {
  uploads: number[];
  versions: number[];
  comments: number[];
};

export type ProfileStore = {
  avatar: (userId: string) => Avatar | null;
  /** When the avatar last changed, or null if the user has none. */
  avatarUpdatedAt: (userId: string) => number | null;
  setAvatar: (userId: string, avatar: Avatar) => void;
  removeAvatar: (userId: string) => void;
  /** Everything the user did since `since` (epoch ms), on any artifact. */
  activity: (userId: string, since: number) => ProfileActivity;
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
  };
}
