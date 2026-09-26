import type { Database } from "bun:sqlite";
import { readContent, removeContent, writeContent } from "./content.ts";

/**
 * Workflow state. `solved` means the question the artifact was shared for has
 * an answer. Archiving is separate, so a solved artifact can also be archived,
 * and archiving one does not claim it was solved.
 */
export type ArtifactStatus = "open" | "solved";

export type Artifact = {
  id: string;
  title: string;
  description: string | null;
  originalFilename: string;
  storageKey: string;
  sha256: string;
  byteSize: number;
  createdBy: string;
  /** Joined from the user table, for display. */
  createdByName: string;
  createdByEmail: string;
  createdAt: Date;
  updatedAt: Date;
  status: ArtifactStatus;
  statusChangedAt: Date | null;
  statusChangedBy: string | null;
  archivedAt: Date | null;
  archivedBy: string | null;
  /** How many versions exist. The current one is the highest numbered. */
  versionCount: number;
  currentVersionId: string;
};

/**
 * One upload of an artifact. The artifact row mirrors the columns of its
 * current version, so every read that does not care about history is a
 * single-table read.
 */
export type ArtifactVersion = {
  id: string;
  artifactId: string;
  number: number;
  originalFilename: string;
  storageKey: string;
  sha256: string;
  byteSize: number;
  createdBy: string;
  createdByName: string;
  createdByEmail: string;
  createdAt: Date;
};

export type CreateArtifactInput = {
  title: string;
  description?: string | null;
  originalFilename: string;
  content: Uint8Array;
  /** Markdown supplied with this version, instead of generated from its HTML. */
  providedMarkdown?: string;
  /** The entry schema this version declares, already checked. */
  entrySchema?: string | null;
  /** Taken from the session by the caller. Never from the request body. */
  createdBy: string;
};

export type AddVersionInput = {
  artifactId: string;
  /** Undefined keeps the artifact's description. Null clears it. */
  description?: string | null;
  originalFilename: string;
  content: Uint8Array;
  /** Markdown supplied with this version, instead of generated from its HTML. */
  providedMarkdown?: string;
  /** The entry schema this version declares, already checked. */
  entrySchema?: string | null;
  createdBy: string;
};

/** How a listing is ordered. The default is the most recently updated first. */
export type ListSort =
  | "updated-desc"
  | "updated-asc"
  | "created-desc"
  | "created-asc"
  | "title-asc"
  | "title-desc";

export const LIST_SORTS: readonly ListSort[] = [
  "updated-desc",
  "updated-asc",
  "created-desc",
  "created-asc",
  "title-asc",
  "title-desc",
];

export const DEFAULT_LIST_SORT: ListSort = "updated-desc";

export type TagMatch = "all" | "any";

export type ListOptions = {
  limit?: number;
  cursor?: string | null;
  sort?: ListSort | null;
  /** Matches title and description. Absent or empty means no filter. */
  query?: string | null;
  status?: ArtifactStatus | null;
  /** Filters to artifacts filed directly in this folder. */
  folderId?: string | null;
  /** Filters by tag ids. All selected tags must match unless tagMatch is any. */
  tagIds?: string[];
  tagMatch?: TagMatch;
  /** Archived artifacts are left out unless they are asked for. */
  includeArchived?: boolean;
};

export type ListResult = { items: Artifact[]; nextCursor: string | null };

export const DEFAULT_PAGE_SIZE = 24;
export const MAX_PAGE_SIZE = 100;

/** The metadata row exists, but its bytes are not on disk. */
export class ContentMissingError extends Error {
  constructor(readonly artifactId: string) {
    super(`Artifact ${artifactId} has no stored content`);
    this.name = "ContentMissingError";
  }
}

export class InvalidCursorError extends Error {
  constructor() {
    super("The pagination cursor is not valid");
    this.name = "InvalidCursorError";
  }
}

type Row = {
  id: string;
  title: string;
  description: string | null;
  originalFilename: string;
  storageKey: string;
  sha256: string;
  byteSize: number;
  createdBy: string;
  createdByName: string;
  createdByEmail: string;
  createdAt: number;
  updatedAt: number;
  status: ArtifactStatus;
  statusChangedAt: number | null;
  statusChangedBy: string | null;
  archivedAt: number | null;
  archivedBy: string | null;
  versionCount: number;
  currentVersionId: string;
};

type VersionRow = {
  id: string;
  artifactId: string;
  number: number;
  originalFilename: string;
  storageKey: string;
  sha256: string;
  byteSize: number;
  createdBy: string;
  createdByName: string;
  createdByEmail: string;
  createdAt: number;
};

/** Artifact columns plus the creator's name and version facts, which every read needs. */
const SELECT_ARTIFACT = `
  select artifacts.*, "user".name as createdByName, "user".email as createdByEmail,
    (select count(*) from artifactVersions where artifactVersions.artifactId = artifacts.id)
      as versionCount,
    (select id from artifactVersions where artifactVersions.artifactId = artifacts.id
      order by number desc limit 1) as currentVersionId
  from artifacts join "user" on "user".id = artifacts.createdBy`;

const SELECT_VERSION = `
  select artifactVersions.*, "user".name as createdByName, "user".email as createdByEmail
  from artifactVersions join "user" on "user".id = artifactVersions.createdBy`;

function toArtifact(row: Row): Artifact {
  return {
    ...row,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
    statusChangedAt: row.statusChangedAt === null ? null : new Date(row.statusChangedAt),
    archivedAt: row.archivedAt === null ? null : new Date(row.archivedAt),
  };
}

function toVersion(row: VersionRow): ArtifactVersion {
  return { ...row, createdAt: new Date(row.createdAt) };
}

type Order = { column: string; direction: "asc" | "desc"; key: (row: Row) => string | number };

const ORDERS: Record<ListSort, Order> = {
  "updated-desc": { column: "artifacts.updatedAt", direction: "desc", key: (row) => row.updatedAt },
  "updated-asc": { column: "artifacts.updatedAt", direction: "asc", key: (row) => row.updatedAt },
  "created-desc": { column: "artifacts.createdAt", direction: "desc", key: (row) => row.createdAt },
  "created-asc": { column: "artifacts.createdAt", direction: "asc", key: (row) => row.createdAt },
  "title-asc": {
    column: "artifacts.title collate nocase",
    direction: "asc",
    key: (row) => row.title,
  },
  "title-desc": {
    column: "artifacts.title collate nocase",
    direction: "desc",
    key: (row) => row.title,
  },
};

type Cursor = { sort: ListSort; key: string | number; id: string };

/**
 * The cursor carries the sort key and id of the last row of a page, and the
 * sort that produced it. Ordering is by the sort key and then by id, so rows
 * that share a key still have one fixed order and a page boundary can never
 * skip or repeat a row. A cursor from one sort is refused under another, since
 * its key would land somewhere else in that order.
 */
function encodeCursor(row: Row, sort: ListSort): string {
  const cursor: Cursor = { sort, key: ORDERS[sort].key(row), id: row.id };
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(cursor: string, sort: ListSort): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new InvalidCursorError();
  }
  if (typeof parsed !== "object" || parsed === null) throw new InvalidCursorError();
  const { sort: cursorSort, key, id } = parsed as Partial<Cursor>;
  if (cursorSort !== sort || typeof id !== "string" || id === "") throw new InvalidCursorError();
  const keyIsValid = sort.startsWith("title") ? typeof key === "string" : Number.isSafeInteger(key);
  if (!keyIsValid) throw new InvalidCursorError();
  return { sort, key: key as string | number, id };
}

export type ArtifactStore = {
  create: (input: CreateArtifactInput) => Promise<Artifact>;
  /** Stores new bytes as the next version. Null when the artifact is gone. */
  addVersion: (input: AddVersionInput) => Promise<Artifact | null>;
  /** Highest number first. Empty when the artifact is gone. */
  versions: (artifactId: string) => ArtifactVersion[];
  getVersion: (id: string) => ArtifactVersion | null;
  /**
   * The most recently updated artifact with exactly this title that is not
   * archived, so a re-upload of a document lands on it as a new version.
   */
  findByTitle: (title: string) => Artifact | null;
  /** Records the new status and who set it. Null when the artifact is gone. */
  setStatus: (id: string, status: ArtifactStatus, actorId: string) => Artifact | null;
  /** Archives or restores. Records who did it. Null when the artifact is gone. */
  setArchived: (id: string, archived: boolean, actorId: string) => Artifact | null;
  list: (options?: ListOptions) => ListResult;
  get: (id: string) => Artifact | null;
  /** Null when no such artifact exists. Throws when its bytes are gone. */
  readContent: (id: string) => Promise<{ artifact: Artifact; content: Uint8Array } | null>;
  /** Null when no such version exists. Throws when its bytes are gone. */
  readVersionContent: (
    versionId: string,
  ) => Promise<{ version: ArtifactVersion; content: Uint8Array } | null>;
  /** Every storage key the database knows about, in key order. */
  storageKeys: () => string[];
  /**
   * Folds one artifact into another: every version, comment, and entry of
   * `fromId` moves under `intoId`, versions are renumbered by upload time, and the
   * `fromId` row is removed. Null when either artifact is gone.
   */
  mergeInto: (intoId: string, fromId: string) => Artifact | null;
};

export function createArtifactStore(options: {
  database: Database;
  dataDir: string;
}): ArtifactStore {
  const { database, dataDir } = options;

  const get = (id: string): Artifact | null => {
    const row = database.query(`${SELECT_ARTIFACT} where artifacts.id = ?`).get(id) as Row | null;
    return row ? toArtifact(row) : null;
  };

  const getVersion = (id: string): ArtifactVersion | null => {
    const row = database
      .query(`${SELECT_VERSION} where artifactVersions.id = ?`)
      .get(id) as VersionRow | null;
    return row ? toVersion(row) : null;
  };

  // Prepared on each call: the store can be created before the schema exists.
  const insertVersion = () =>
    database.query(
      `insert into artifactVersions
         (id, artifactId, number, originalFilename, storageKey, sha256, byteSize, createdBy, createdAt,
          entrySchema)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

  const insertProvidedMarkdown = () =>
    database.query(
      `insert into artifactMarkdown
         (versionId, converterVersion, sourceSha256, markdown, isEmpty, generatedAt)
       values (?, 'provided', ?, ?, ?, ?)`,
    );

  return {
    get,
    getVersion,

    async create(input) {
      const id = Bun.randomUUIDv7();
      // The bytes land on disk first. Metadata is committed only after that
      // succeeds, so a failed write cannot leave a row pointing at nothing.
      const stored = await writeContent(dataDir, id, input.content);
      const now = Date.now();

      try {
        // Version 1 shares the artifact's id, which is what its storage key
        // was derived from.
        database.transaction(() => {
          database
            .query(
              `insert into artifacts
                 (id, title, description, originalFilename, storageKey, sha256, byteSize,
                  createdBy, createdAt, updatedAt)
               values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              id,
              input.title,
              input.description ?? null,
              input.originalFilename,
              stored.storageKey,
              stored.sha256,
              stored.byteSize,
              input.createdBy,
              now,
              now,
            );
          insertVersion().run(
            id,
            id,
            1,
            input.originalFilename,
            stored.storageKey,
            stored.sha256,
            stored.byteSize,
            input.createdBy,
            now,
            input.entrySchema ?? null,
          );
          if (input.providedMarkdown !== undefined) {
            insertProvidedMarkdown().run(
              id,
              stored.sha256,
              input.providedMarkdown,
              input.providedMarkdown.trim() === "" ? 1 : 0,
              now,
            );
          }
        })();
      } catch (cause) {
        // Nothing references the file yet, so removing it here keeps the
        // failure from leaving an orphan behind.
        await removeContent(dataDir, stored.storageKey).catch(() => {});
        throw cause;
      }

      const created = get(id);
      if (!created) throw new Error(`Artifact ${id} disappeared right after it was written`);
      return created;
    },

    async addVersion(input) {
      if (!get(input.artifactId)) return null;
      const id = Bun.randomUUIDv7();
      const stored = await writeContent(dataDir, id, input.content);
      const now = Date.now();

      try {
        // The number is read and written in one transaction, so two uploads
        // arriving together cannot both become the same version.
        const changed = database.transaction(() => {
          const last = database
            .query("select max(number) as number from artifactVersions where artifactId = ?")
            .get(input.artifactId) as { number: number | null };
          if (last.number === null) return false;
          insertVersion().run(
            id,
            input.artifactId,
            last.number + 1,
            input.originalFilename,
            stored.storageKey,
            stored.sha256,
            stored.byteSize,
            input.createdBy,
            now,
            input.entrySchema ?? null,
          );
          if (input.providedMarkdown !== undefined) {
            insertProvidedMarkdown().run(
              id,
              stored.sha256,
              input.providedMarkdown,
              input.providedMarkdown.trim() === "" ? 1 : 0,
              now,
            );
          }
          const description = input.description === undefined ? "artifacts.description" : "?";
          const parameters: (string | number | null)[] = [
            input.originalFilename,
            stored.storageKey,
            stored.sha256,
            stored.byteSize,
            now,
          ];
          if (input.description !== undefined) parameters.push(input.description);
          parameters.push(input.artifactId);
          database
            .query(
              `update artifacts set originalFilename = ?, storageKey = ?, sha256 = ?,
                 byteSize = ?, updatedAt = ?, description = ${description}
               where id = ?`,
            )
            .run(...parameters);
          return true;
        })();
        if (!changed) {
          await removeContent(dataDir, stored.storageKey).catch(() => {});
          return null;
        }
      } catch (cause) {
        await removeContent(dataDir, stored.storageKey).catch(() => {});
        throw cause;
      }

      return get(input.artifactId);
    },

    versions(artifactId) {
      const rows = database
        .query(
          `${SELECT_VERSION} where artifactVersions.artifactId = ?
           order by artifactVersions.number desc`,
        )
        .all(artifactId) as VersionRow[];
      return rows.map(toVersion);
    },

    findByTitle(title) {
      const row = database
        .query(
          `${SELECT_ARTIFACT} where artifacts.title = ? and artifacts.archivedAt is null
           order by artifacts.updatedAt desc, artifacts.id desc limit 1`,
        )
        .get(title) as Row | null;
      return row ? toArtifact(row) : null;
    },

    setStatus(id, status, actorId) {
      const now = Date.now();
      database
        .query(
          `update artifacts set status = ?, statusChangedAt = ?, statusChangedBy = ?, updatedAt = ?
           where id = ?`,
        )
        .run(status, now, actorId, now, id);
      return get(id);
    },

    setArchived(id, archived, actorId) {
      const now = Date.now();
      database
        .query("update artifacts set archivedAt = ?, archivedBy = ?, updatedAt = ? where id = ?")
        .run(archived ? now : null, archived ? actorId : null, now, id);
      return get(id);
    },

    list(listOptions = {}) {
      const limit = Math.min(Math.max(listOptions.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
      const sort = listOptions.sort ?? DEFAULT_LIST_SORT;
      const order = ORDERS[sort];
      const cursor = listOptions.cursor ? decodeCursor(listOptions.cursor, sort) : null;
      const search = listOptions.query?.trim();

      const conditions: string[] = [];
      const parameters: (string | number)[] = [];
      if (cursor) {
        const beyond = order.direction === "desc" ? "<" : ">";
        conditions.push(
          `(${order.column} ${beyond} ? or (${order.column} = ? and artifacts.id ${beyond} ?))`,
        );
        parameters.push(cursor.key, cursor.key, cursor.id);
      }
      if (listOptions.status) {
        conditions.push("artifacts.status = ?");
        parameters.push(listOptions.status);
      }
      if (listOptions.folderId) {
        conditions.push("artifacts.folderId = ?");
        parameters.push(listOptions.folderId);
      }
      if (listOptions.tagIds && listOptions.tagIds.length > 0) {
        const placeholders = listOptions.tagIds.map(() => "?").join(", ");
        if (listOptions.tagMatch === "any") {
          conditions.push(
            `exists (select 1 from artifactTags where artifactTags.artifactId = artifacts.id
              and artifactTags.tagId in (${placeholders}))`,
          );
          parameters.push(...listOptions.tagIds);
        } else {
          conditions.push(
            `artifacts.id in (select artifactId from artifactTags where tagId in (${placeholders})
              group by artifactId having count(distinct tagId) = ?)`,
          );
          parameters.push(...listOptions.tagIds, listOptions.tagIds.length);
        }
      }
      if (!listOptions.includeArchived) {
        conditions.push("artifacts.archivedAt is null");
      }
      if (search) {
        // The escape clause lets a search term contain % or _ without those
        // characters acting as wildcards.
        conditions.push(
          "(artifacts.title like ? escape '\\' or artifacts.description like ? escape '\\')",
        );
        const pattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
        parameters.push(pattern, pattern);
      }
      const where = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";

      // One extra row tells us whether another page exists without a count.
      const rows = database
        .query(
          `${SELECT_ARTIFACT} ${where}
           order by ${order.column} ${order.direction}, artifacts.id ${order.direction} limit ?`,
        )
        .all(...parameters, limit + 1) as Row[];

      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map(toArtifact),
        nextCursor: rows.length > limit && last ? encodeCursor(last, sort) : null,
      };
    },

    async readContent(id) {
      const artifact = get(id);
      if (!artifact) return null;
      const content = await readContent(dataDir, artifact.storageKey);
      if (!content) throw new ContentMissingError(id);
      return { artifact, content };
    },

    async readVersionContent(versionId) {
      const version = getVersion(versionId);
      if (!version) return null;
      const content = await readContent(dataDir, version.storageKey);
      if (!content) throw new ContentMissingError(version.artifactId);
      return { version, content };
    },

    mergeInto(intoId, fromId) {
      const into = get(intoId);
      const from = get(fromId);
      if (!into || !from || intoId === fromId) return null;

      database.transaction(() => {
        // Both artifacts have a version 1, so the moved versions take negative
        // numbers until everything is renumbered below.
        database
          .query(
            "update artifactVersions set artifactId = ?, number = -number where artifactId = ?",
          )
          .run(intoId, fromId);
        database
          .query("update artifactComments set artifactId = ? where artifactId = ?")
          .run(intoId, fromId);
        // Keep every tag from both artifacts. A duplicate pair stays once,
        // then no assignment points at the row the cascade will remove.
        database
          .query(
            `insert or ignore into artifactTags (artifactId, tagId, createdBy, createdAt)
             select ?, tagId, createdBy, createdAt from artifactTags where artifactId = ?`,
          )
          .run(intoId, fromId);
        database.query("delete from artifactTags where artifactId = ?").run(fromId);
        // One value per person per key survives: the one written last.
        database
          .query(
            `insert into artifactEntries (artifactId, authorId, key, value, updatedAt)
             select ?, authorId, key, value, updatedAt from artifactEntries where artifactId = ? and true
             on conflict (artifactId, authorId, key) do update
               set value = excluded.value, updatedAt = excluded.updatedAt
               where excluded.updatedAt > artifactEntries.updatedAt`,
          )
          .run(intoId, fromId);
        database.query("delete from artifactEntries where artifactId = ?").run(fromId);
        // Nothing points at the old row any more, so the cascade removes nothing.
        database.query("delete from artifacts where id = ?").run(fromId);

        // Renumbered in upload order. Passing every row through a negative
        // number first keeps the (artifactId, number) constraint satisfied.
        const ordered = database
          .query("select id from artifactVersions where artifactId = ? order by createdAt, id")
          .all(intoId) as { id: string }[];
        const renumber = database.query("update artifactVersions set number = ? where id = ?");
        // Below every number the move above could have produced.
        ordered.forEach((row, index) => {
          renumber.run(-(ordered.length + index + 1), row.id);
        });
        ordered.forEach((row, index) => {
          renumber.run(index + 1, row.id);
        });

        const current = ordered.at(-1);
        if (!current) throw new Error(`Artifact ${intoId} has no versions after the merge`);
        database
          .query(
            `update artifacts set
               originalFilename = v.originalFilename, storageKey = v.storageKey,
               sha256 = v.sha256, byteSize = v.byteSize,
               description = coalesce(artifacts.description, ?),
               createdAt = min(artifacts.createdAt, ?),
               updatedAt = max(artifacts.updatedAt, ?)
             from (select * from artifactVersions where id = ?) as v
             where artifacts.id = ?`,
          )
          .run(
            from.description,
            from.createdAt.getTime(),
            from.updatedAt.getTime(),
            current.id,
            intoId,
          );
      })();

      return get(intoId);
    },

    storageKeys() {
      const rows = database
        .query("select storageKey from artifactVersions order by storageKey")
        .all() as { storageKey: string }[];
      return rows.map((row) => row.storageKey);
    },
  };
}
