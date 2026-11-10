import type { Database } from "bun:sqlite";
import type { Reader } from "../access/reader.ts";
import { READABLE, readableBy, TAG_SEEN, tagSeenBy } from "./readable.ts";
import { revokeLinksUnder } from "./teams.ts";

export type Folder = {
  id: string;
  name: string;
  parentId: string | null;
  createdBy: string;
  createdAt: Date;
  updatedBy: string;
  updatedAt: Date;
  /** Counts only the artifacts the viewer the folder was read for can see. */
  artifactCount: number;
};

export type Tag = {
  id: string;
  name: string;
  createdBy: string;
  createdAt: Date;
  updatedBy: string;
  updatedAt: Date;
  artifactCount: number;
};

export type FolderReference = Pick<Folder, "id" | "name" | "parentId">;
export type TagReference = Pick<Tag, "id" | "name">;
export type ArtifactOrganization = { folder: FolderReference | null; tags: TagReference[] };

export type ArtifactOrganizationInput = {
  artifactId: string;
  /** Undefined leaves the current folder unchanged. Null files the artifact at the root. */
  folderId?: string | null;
  /** Undefined leaves the current tags unchanged. An empty array removes every tag. */
  tagIds?: string[];
  actorId: string;
};

/**
 * Each read takes the reader whose artifacts it counts. Folders and tags are
 * filtered by the caller, except where a method says otherwise.
 */
export type OrganizationStore = {
  listFolders: (reader: Reader) => Folder[];
  /** Artifacts the reader can see that are filed in no folder. */
  countUnfiled: (reader: Reader) => number;
  getFolder: (id: string, reader: Reader) => Folder | null;
  createFolder: (input: {
    name: string;
    parentId: string | null;
    actorId: string;
    reader: Reader;
  }) => Folder;
  /**
   * With `revokeLinks`, also revokes the public links of every artifact in the
   * folder and below it, in the same transaction.
   */
  updateFolder: (
    id: string,
    input: {
      name?: string;
      parentId?: string | null;
      actorId: string;
      reader: Reader;
      revokeLinks?: boolean;
    },
  ) => { folder: Folder; revoked: string[] } | null;
  /** Reparents child folders and files direct artifacts in the parent. */
  removeFolder: (id: string) => { artifactIds: string[] } | null;
  /** Whether any artifact or folder is filed directly in the folder. */
  hasContent: (id: string) => boolean;
  /** Only the tags `TAG_SEEN` lets the reader see. */
  listTags: (reader: Reader) => Tag[];
  getTag: (id: string, reader: Reader) => Tag | null;
  /** Only the tags `TAG_SEEN` lets the reader see. */
  getTags: (ids: string[], reader: Reader) => Tag[];
  createTag: (input: { name: string; actorId: string; reader: Reader }) => Tag;
  updateTag: (id: string, input: { name: string; actorId: string; reader: Reader }) => Tag | null;
  /** Removes every assignment and returns the affected artifact ids. */
  removeTag: (id: string) => { artifactIds: string[] } | null;
  assignments: (artifactIds: string[]) => Map<string, ArtifactOrganization>;
  /** Returns true only when the artifact's organization changed. */
  setArtifactOrganization: (input: ArtifactOrganizationInput) => boolean;
};

type FolderRow = Omit<Folder, "createdAt" | "updatedAt"> & {
  createdAt: number;
  updatedAt: number;
};

type TagRow = Omit<Tag, "createdAt" | "updatedAt"> & { createdAt: number; updatedAt: number };

function toFolder(row: FolderRow): Folder {
  return { ...row, createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt) };
}

function toTag(row: TagRow): Tag {
  return { ...row, createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt) };
}

// Both take `readableBy(...)` as their first parameters.
const SELECT_FOLDER = `
  select folders.*, (select count(*) from artifacts
    where artifacts.folderId = folders.id and ${READABLE}) as artifactCount
  from folders`;
const SELECT_TAG = `
  select tags.*, (select count(*) from artifactTags
    join artifacts on artifacts.id = artifactTags.artifactId
    where artifactTags.tagId = tags.id and ${READABLE}) as artifactCount
  from tags`;

export function createOrganizationStore(database: Database): OrganizationStore {
  const getFolder = (id: string, reader: Reader): Folder | null => {
    const row = database
      .query(`${SELECT_FOLDER} where folders.id = ?`)
      .get(...readableBy(reader.userId, reader), id) as FolderRow | null;
    return row ? toFolder(row) : null;
  };
  const getTag = (id: string, reader: Reader): Tag | null => {
    const row = database
      .query(`${SELECT_TAG} where tags.id = ?`)
      .get(...readableBy(reader.userId, reader), id) as TagRow | null;
    return row ? toTag(row) : null;
  };
  const tagExists = (id: string): boolean =>
    database.query("select 1 from tags where id = ?").get(id) !== null;

  return {
    getFolder,
    getTag,

    countUnfiled(reader) {
      const row = database
        .query(`select count(*) as count from artifacts where folderId is null and ${READABLE}`)
        .get(...readableBy(reader.userId, reader)) as { count: number };
      return row.count;
    },

    listFolders(reader) {
      const rows = database
        .query(`${SELECT_FOLDER} order by folders.name collate nocase, folders.id`)
        .all(...readableBy(reader.userId, reader)) as FolderRow[];
      return rows.map(toFolder);
    },

    createFolder(input) {
      const id = Bun.randomUUIDv7();
      const now = Date.now();
      database
        .query(
          `insert into folders (id, name, parentId, createdBy, createdAt, updatedBy, updatedAt)
           values (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.name, input.parentId, input.actorId, now, input.actorId, now);
      const folder = getFolder(id, input.reader);
      if (!folder) throw new Error(`Folder ${id} disappeared right after it was written`);
      return folder;
    },

    updateFolder(id, input) {
      const folder = getFolder(id, input.reader);
      if (!folder) return null;
      const parentId = input.parentId === undefined ? folder.parentId : input.parentId;
      const name = input.name ?? folder.name;
      const now = Date.now();
      const revoked = database.transaction(() => {
        database
          .query(
            "update folders set name = ?, parentId = ?, updatedBy = ?, updatedAt = ? where id = ?",
          )
          .run(name, parentId, input.actorId, now, id);
        return input.revokeLinks ? revokeLinksUnder(database, id, input.actorId, now) : [];
      })();
      const updated = getFolder(id, input.reader);
      return updated ? { folder: updated, revoked } : null;
    },

    hasContent(id) {
      return (
        database
          .query(
            `select 1 from artifacts where folderId = ?1
             union all select 1 from folders where parentId = ?1 limit 1`,
          )
          .get(id) !== null
      );
    },

    removeFolder(id) {
      const folder = database.query("select parentId from folders where id = ?").get(id) as {
        parentId: string | null;
      } | null;
      if (!folder) return null;
      const artifactRows = database
        .query("select id from artifacts where folderId = ? order by id")
        .all(id) as { id: string }[];
      const artifactIds = artifactRows.map((row) => row.id);
      const now = Date.now();
      database.transaction(() => {
        database
          .query("update folders set parentId = ? where parentId = ?")
          .run(folder.parentId, id);
        database
          .query("update artifacts set folderId = ?, updatedAt = ? where folderId = ?")
          .run(folder.parentId, now, id);
        database.query("delete from folders where id = ?").run(id);
      })();
      return { artifactIds };
    },

    listTags(reader) {
      const rows = database
        .query(`${SELECT_TAG} where ${TAG_SEEN} order by tags.name collate nocase, tags.id`)
        .all(...readableBy(reader.userId, reader), ...tagSeenBy(reader)) as TagRow[];
      return rows.map(toTag);
    },

    getTags(ids, reader) {
      if (ids.length === 0) return [];
      const placeholders = ids.map(() => "?").join(", ");
      const rows = database
        .query(`${SELECT_TAG} where tags.id in (${placeholders}) and ${TAG_SEEN}`)
        .all(...readableBy(reader.userId, reader), ...ids, ...tagSeenBy(reader)) as TagRow[];
      return rows.map(toTag);
    },

    createTag(input) {
      const id = Bun.randomUUIDv7();
      const now = Date.now();
      database
        .query(
          `insert into tags (id, name, createdBy, createdAt, updatedBy, updatedAt)
           values (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.name, input.actorId, now, input.actorId, now);
      const tag = getTag(id, input.reader);
      if (!tag) throw new Error(`Tag ${id} disappeared right after it was written`);
      return tag;
    },

    updateTag(id, input) {
      const now = Date.now();
      database
        .query("update tags set name = ?, updatedBy = ?, updatedAt = ? where id = ?")
        .run(input.name, input.actorId, now, id);
      return getTag(id, input.reader);
    },

    removeTag(id) {
      if (!tagExists(id)) return null;
      const artifactRows = database
        .query("select artifactId as id from artifactTags where tagId = ? order by artifactId")
        .all(id) as { id: string }[];
      const artifactIds = artifactRows.map((row) => row.id);
      const now = Date.now();
      database.transaction(() => {
        database
          .query(
            `update artifacts set updatedAt = ?
             where id in (select artifactId from artifactTags where tagId = ?)`,
          )
          .run(now, id);
        database.query("delete from tags where id = ?").run(id);
      })();
      return { artifactIds };
    },

    assignments(artifactIds) {
      const result = new Map<string, ArtifactOrganization>();
      if (artifactIds.length === 0) return result;
      const placeholders = artifactIds.map(() => "?").join(", ");
      const folders = database
        .query(
          `select artifacts.id as artifactId, folders.id, folders.name, folders.parentId
           from artifacts left join folders on folders.id = artifacts.folderId
           where artifacts.id in (${placeholders})`,
        )
        .all(...artifactIds) as {
        artifactId: string;
        id: string | null;
        name: string | null;
        parentId: string | null;
      }[];
      for (const row of folders) {
        result.set(row.artifactId, {
          folder:
            row.id === null || row.name === null
              ? null
              : { id: row.id, name: row.name, parentId: row.parentId },
          tags: [],
        });
      }
      const tags = database
        .query(
          `select artifactTags.artifactId, tags.id, tags.name
           from artifactTags join tags on tags.id = artifactTags.tagId
           where artifactTags.artifactId in (${placeholders})
           order by tags.name collate nocase, tags.id`,
        )
        .all(...artifactIds) as { artifactId: string; id: string; name: string }[];
      for (const row of tags) result.get(row.artifactId)?.tags.push({ id: row.id, name: row.name });
      return result;
    },

    setArtifactOrganization(input) {
      const current = this.assignments([input.artifactId]).get(input.artifactId);
      if (!current) return false;
      const folderChanged = input.folderId !== undefined && input.folderId !== current.folder?.id;
      const tagIds = input.tagIds;
      const tagsChanged =
        tagIds !== undefined &&
        (tagIds.length !== current.tags.length ||
          tagIds.some((id) => !current.tags.some((tag) => tag.id === id)));
      if (!folderChanged && !tagsChanged) return false;

      const now = Date.now();
      database.transaction(() => {
        if (folderChanged) {
          database
            .query("update artifacts set folderId = ?, updatedAt = ? where id = ?")
            .run(input.folderId ?? null, now, input.artifactId);
        } else if (tagsChanged) {
          database
            .query("update artifacts set updatedAt = ? where id = ?")
            .run(now, input.artifactId);
        }
        if (tagsChanged) {
          database.query("delete from artifactTags where artifactId = ?").run(input.artifactId);
          const insert = database.query(
            `insert into artifactTags (artifactId, tagId, createdBy, createdAt) values (?, ?, ?, ?)`,
          );
          for (const tagId of tagIds ?? []) insert.run(input.artifactId, tagId, input.actorId, now);
        }
      })();
      return true;
    },
  };
}
