import type { Database } from "bun:sqlite";

export type Entry = {
  artifactId: string;
  key: string;
  value: unknown;
  updatedAt: Date;
  author: { id: string; name: string; email: string };
};

export type EntryStore = {
  /** Oldest change first. */
  list: (artifactId: string) => Entry[];
  get: (artifactId: string, authorId: string, key: string) => Entry | null;
  /** Creates or replaces this author's value for the key. `value` is JSON text. */
  set: (input: { artifactId: string; authorId: string; key: string; value: string }) => Entry;
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
  authorEmail: string;
};

const SELECT_ENTRY = `
  select artifactEntries.*, "user".name as authorName, "user".email as authorEmail
  from artifactEntries join "user" on "user".id = artifactEntries.authorId`;

function toEntry(row: Row): Entry {
  return {
    artifactId: row.artifactId,
    key: row.key,
    value: JSON.parse(row.value),
    updatedAt: new Date(row.updatedAt),
    author: { id: row.authorId, name: row.authorName, email: row.authorEmail },
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
          `${SELECT_ENTRY} where artifactEntries.artifactId = ?
           order by artifactEntries.updatedAt, artifactEntries.authorId, artifactEntries.key`,
        )
        .all(artifactId) as Row[];
      return rows.map(toEntry);
    },

    set(input) {
      database
        .query(
          `insert into artifactEntries (artifactId, authorId, key, value, updatedAt)
           values (?, ?, ?, ?, ?)
           on conflict (artifactId, authorId, key)
           do update set value = excluded.value, updatedAt = excluded.updatedAt`,
        )
        .run(input.artifactId, input.authorId, input.key, input.value, Date.now());
      const entry = get(input.artifactId, input.authorId, input.key);
      if (!entry) throw new Error(`Entry ${input.key} disappeared right after it was written`);
      return entry;
    },

    remove(artifactId, authorId, key) {
      const result = database
        .query("delete from artifactEntries where artifactId = ? and authorId = ? and key = ?")
        .run(artifactId, authorId, key);
      return result.changes > 0;
    },

    count(artifactId, authorId) {
      const row = database
        .query("select count(*) as n from artifactEntries where artifactId = ? and authorId = ?")
        .get(artifactId, authorId) as { n: number };
      return row.n;
    },

    valueBytes(artifactId, except) {
      const row = database
        .query(
          `select coalesce(sum(length(cast(value as blob))), 0) as n from artifactEntries
           where artifactId = ? and not (authorId = ? and key = ?)`,
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
