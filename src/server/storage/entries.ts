import type { Database } from "bun:sqlite";
import { JOIN_DISPLAY_NAME, USER_NAME } from "./names.ts";

export type Entry = {
  artifactId: string;
  key: string;
  value: unknown;
  updatedAt: Date;
  /** A guest has no email. Their id is guestAuthorId's. */
  author: { id: string; name: string; email: string | null; guest?: true };
};

/** User ids have no colon, so this prefix cannot name a user. */
const GUEST_PREFIX = "guest:";

/** The author id of someone who opened a public link and gave a name. */
export function guestAuthorId(guestId: string): string {
  return `${GUEST_PREFIX}${guestId}`;
}

function guestIdOf(authorId: string): string | null {
  return authorId.startsWith(GUEST_PREFIX) ? authorId.slice(GUEST_PREFIX.length) : null;
}

export type EntryStore = {
  /** Oldest change first. */
  list: (artifactId: string) => Entry[];
  get: (artifactId: string, authorId: string, key: string) => Entry | null;
  /**
   * Creates or replaces this author's value for the key. `value` is JSON text.
   * With `notify`, the write shows in the activity feed from now on, under a new id.
   */
  set: (input: {
    artifactId: string;
    authorId: string;
    key: string;
    value: string;
    notify: boolean;
    inApp: boolean;
    /** Required for a guest, whose name is on each of their rows. Guests never notify. */
    guestName?: string;
  }) => Entry;
  /** Returns false when the author had no value for the key. */
  remove: (artifactId: string, authorId: string, key: string) => boolean;
  /** How many keys this author holds on the artifact. */
  count: (artifactId: string, authorId: string) => number;
  /** Bytes of JSON in the artifact's values, leaving out one author's value for one key. */
  valueBytes: (artifactId: string, except: { authorId: string; key: string }) => number;
  /** The schema text the version declared, or null. */
  schema: (versionId: string) => string | null;
};

type Row = {
  artifactId: string;
  key: string;
  value: string;
  updatedAt: number;
  authorId: string;
  authorName: string;
  authorEmail: string | null;
  guest: number;
};

const SELECT_ENTRY = `
  select artifactEntries.artifactId, artifactEntries.key, artifactEntries.value,
    artifactEntries.updatedAt, artifactEntries.authorId, ${USER_NAME} as authorName,
    "user".email as authorEmail, 0 as guest
  from artifactEntries join "user" on "user".id = artifactEntries.authorId
    ${JOIN_DISPLAY_NAME}`;

const SELECT_GUEST_ENTRY = `
  select artifactId, key, value, updatedAt, '${GUEST_PREFIX}' || guestId as authorId,
    guestName as authorName, null as authorEmail, 1 as guest
  from artifactGuestEntries`;

function toEntry(row: Row): Entry {
  return {
    artifactId: row.artifactId,
    key: row.key,
    value: JSON.parse(row.value),
    updatedAt: new Date(row.updatedAt),
    author: {
      id: row.authorId,
      name: row.authorName,
      email: row.authorEmail,
      ...(row.guest === 1 && { guest: true as const }),
    },
  };
}

/**
 * Each person's entries are their own rows, keyed by (artifact, author, key).
 * Two people writing the same key write two rows, so nobody overwrites anyone
 * else, and a person changing a value replaces only their own.
 */
export function createEntryStore(options: { database: Database }): EntryStore {
  const { database } = options;

  const get = (artifactId: string, authorId: string, key: string): Entry | null => {
    const guestId = guestIdOf(authorId);
    if (guestId !== null) {
      const row = database
        .query(`${SELECT_GUEST_ENTRY} where artifactId = ? and guestId = ? and key = ?`)
        .get(artifactId, guestId, key) as Row | null;
      return row ? toEntry(row) : null;
    }
    const row = database
      .query(
        `${SELECT_ENTRY} where artifactEntries.artifactId = ? and artifactEntries.authorId = ?
           and artifactEntries.key = ?`,
      )
      .get(artifactId, authorId, key) as Row | null;
    return row ? toEntry(row) : null;
  };

  return {
    get,

    list(artifactId) {
      const rows = database
        .query(
          `${SELECT_ENTRY} where artifactEntries.artifactId = ?1
           union all ${SELECT_GUEST_ENTRY} where artifactId = ?1
           order by updatedAt, authorId, key`,
        )
        .all(artifactId) as Row[];
      return rows.map(toEntry);
    },

    set(input) {
      const now = Date.now();
      const guestId = guestIdOf(input.authorId);
      if (guestId !== null) {
        if (input.guestName === undefined) throw new Error("A guest's entry needs their name");
        database
          .query(
            `insert into artifactGuestEntries (artifactId, guestId, guestName, key, value, updatedAt)
             values (?, ?, ?, ?, ?, ?)
             on conflict (artifactId, guestId, key)
             do update set value = excluded.value, updatedAt = excluded.updatedAt`,
          )
          .run(input.artifactId, guestId, input.guestName, input.key, input.value, now);
        const entry = get(input.artifactId, input.authorId, input.key);
        if (!entry) throw new Error(`Entry ${input.key} disappeared right after it was written`);
        return entry;
      }
      database
        .query(
          `insert into artifactEntries (artifactId, authorId, key, value, updatedAt, notifiedAt, activityId,
             inApp)
           values (?, ?, ?, ?, ?, ?, ?, ?)
           on conflict (artifactId, authorId, key)
           do update set value = excluded.value, updatedAt = excluded.updatedAt,
             notifiedAt = coalesce(excluded.notifiedAt, artifactEntries.notifiedAt),
             activityId = coalesce(excluded.activityId, artifactEntries.activityId),
             inApp = iif(excluded.notifiedAt is null, artifactEntries.inApp, excluded.inApp)`,
        )
        .run(
          input.artifactId,
          input.authorId,
          input.key,
          input.value,
          now,
          input.notify ? now : null,
          input.notify ? Bun.randomUUIDv7() : null,
          input.inApp ? 1 : 0,
        );
      const entry = get(input.artifactId, input.authorId, input.key);
      if (!entry) throw new Error(`Entry ${input.key} disappeared right after it was written`);
      return entry;
    },

    remove(artifactId, authorId, key) {
      const guestId = guestIdOf(authorId);
      if (guestId !== null) {
        return (
          database
            .query(
              "delete from artifactGuestEntries where artifactId = ? and guestId = ? and key = ?",
            )
            .run(artifactId, guestId, key).changes > 0
        );
      }
      const result = database
        .query("delete from artifactEntries where artifactId = ? and authorId = ? and key = ?")
        .run(artifactId, authorId, key);
      return result.changes > 0;
    },

    count(artifactId, authorId) {
      const guestId = guestIdOf(authorId);
      if (guestId !== null) {
        const row = database
          .query(
            "select count(*) as n from artifactGuestEntries where artifactId = ? and guestId = ?",
          )
          .get(artifactId, guestId) as { n: number };
        return row.n;
      }
      const row = database
        .query("select count(*) as n from artifactEntries where artifactId = ? and authorId = ?")
        .get(artifactId, authorId) as { n: number };
      return row.n;
    },

    valueBytes(artifactId, except) {
      const row = database
        .query(
          `select coalesce(sum(length(cast(value as blob))), 0) as n from (
             select authorId, key, value from artifactEntries where artifactId = ?1
             union all
             select '${GUEST_PREFIX}' || guestId, key, value from artifactGuestEntries
             where artifactId = ?1
           ) where not (authorId = ?2 and key = ?3)`,
        )
        .get(artifactId, except.authorId, except.key) as { n: number };
      return row.n;
    },

    schema(versionId) {
      const row = database
        .query("select entrySchema from artifactVersions where id = ?")
        .get(versionId) as { entrySchema: string | null } | null;
      return row?.entrySchema ?? null;
    },
  };
}
