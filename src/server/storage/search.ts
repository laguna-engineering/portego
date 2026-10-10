import type { Database } from "bun:sqlite";
import { ROOT_FOLDER_ID, VISIBLE } from "./artifacts.ts";

/** The most words a query uses. The rest are ignored. */
const MAX_QUERY_WORDS = 8;

/**
 * The words of a query, split the way the index tokenizer splits text. Only
 * letters and digits remain, so a word can be quoted in an FTS5 query as is.
 */
export function queryWords(query: string): string[] {
  return (query.normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, MAX_QUERY_WORDS);
}

/**
 * The highlight query for the porter index, which matches other forms of
 * whole words. No word is a prefix there: a stem prefix would make "tries"
 * match "trip". Any word counts, because a row may match some words only in
 * the prefix index.
 */
function stemmedQuery(words: string[]): string {
  return words.map((word) => `"${word}"`).join(" OR ");
}

/**
 * The rowids of searchDocuments that match every word. Each word may match in
 * either index, since one query can mix a finished word and one being typed.
 */
function matches(words: string[]): { sql: string; parameters: string[] } {
  const word = `select id from (
      select rowid as id from searchStemmed where searchStemmed match ?
      union
      select rowid as id from searchPrefix where searchPrefix match ?)`;
  return {
    sql: words.map(() => word).join(" intersect "),
    parameters: words.flatMap((one) => [`"${one}"`, `"${one}"*`]),
  };
}

// Each kind joins the document to the artifact it belongs to. A version
// counts only while it is current: the artifact row carries the storage key of
// its current version.
const KIND_JOINS = {
  artifact: `join artifacts on artifacts.id = searchDocuments.refId`,
  version: `join artifactVersions on artifactVersions.id = searchDocuments.refId
    join artifacts on artifacts.id = artifactVersions.artifactId
      and artifacts.storageKey = artifactVersions.storageKey`,
  comment: `join artifactComments on artifactComments.id = searchDocuments.refId
    join artifacts on artifacts.id = artifactComments.artifactId`,
} as const;

export type SearchKind = keyof typeof KIND_JOINS;

const ORDER: Record<SearchKind, string> = {
  artifact: "artifacts.updatedAt desc",
  version: "artifacts.updatedAt desc",
  comment: "artifactComments.createdAt desc",
};

export type SearchScope = {
  viewerId: string | null;
  /** Artifacts filed directly in this folder, or in none for `ROOT_FOLDER_ID`. */
  folderId?: string | null;
  artifactId?: string | null;
  includeArchived?: boolean;
};

function scopeConditions(scope: SearchScope) {
  const conditions = [VISIBLE];
  const parameters: (string | null)[] = [scope.viewerId];
  if (scope.folderId === ROOT_FOLDER_ID) {
    conditions.push("artifacts.folderId is null");
  } else if (scope.folderId) {
    conditions.push("artifacts.folderId = ?");
    parameters.push(scope.folderId);
  }
  if (scope.artifactId) {
    conditions.push("artifacts.id = ?");
    parameters.push(scope.artifactId);
  }
  if (!scope.includeArchived) conditions.push("artifacts.archivedAt is null");
  return { conditions, parameters };
}

/** The documents of one kind that match, joined to their artifacts. Ends in a `where`. */
function kindFrom(kind: SearchKind, match: { sql: string }): string {
  return `from (${match.sql}) as hits
      join searchDocuments on searchDocuments.id = hits.id
      ${KIND_JOINS[kind]}
      where searchDocuments.kind = '${kind}'`;
}

/**
 * A subquery for the ids of artifacts whose title, description, current
 * text, or comments match `query`. Visibility is left to the caller.
 */
export function matchingArtifactIds(query: string): { sql: string; parameters: string[] } | null {
  const words = queryWords(query);
  if (words.length === 0) return null;
  const match = matches(words);
  const kinds = Object.keys(KIND_JOINS) as SearchKind[];
  return {
    sql: kinds.map((kind) => `select artifacts.id ${kindFrom(kind, match)}`).join(" union "),
    parameters: kinds.flatMap(() => match.parameters),
  };
}

/** [start, end) offsets into a text. */
export type Range = [number, number];

export type SearchHit = {
  refId: string;
  artifactId: string;
  title: string;
  body: string;
  /**
   * Where the porter index matched, which includes other forms of a word
   * ("tried" for "tries") that a plain text search cannot find.
   */
  stemmed: { title: Range[]; body: Range[] };
};

const START = "\u0002";
const END = "\u0003";

/** The ranges FTS5 highlight() marked with START and END. */
function markedRanges(marked: string): Range[] {
  const ranges: Range[] = [];
  let offset = 0;
  let start = -1;
  for (let index = 0; index < marked.length; index += 1) {
    const character = marked[index];
    if (character === START) start = offset;
    else if (character === END && start !== -1) {
      ranges.push([start, offset]);
      start = -1;
    } else offset += 1;
  }
  return ranges;
}

export type NameHit = { id: string; name: string; count: number };

export type SearchStore = {
  /**
   * Replaces the text indexed for a version, made by `textVersion` of the
   * code that turns a version into text. Does nothing if the version is gone.
   */
  indexVersion: (versionId: string, text: string, textVersion: string) => void;
  /**
   * Current versions whose text is missing or was made by another
   * `textVersion`, such as those uploaded before search existed.
   */
  staleVersions: (textVersion: string) => string[];
  /** The most recent matches of one kind. */
  search: (kind: SearchKind, query: string, scope: SearchScope, limit: number) => SearchHit[];
  /** How many artifacts in scope match `query` anywhere, as the gallery filter counts them. */
  countArtifacts: (query: string, scope: SearchScope) => number;
  /** Tags whose name contains every word, with how many artifacts in scope carry each. */
  tags: (query: string, scope: SearchScope, limit: number) => NameHit[];
  /** Folders whose name contains every word, with how many artifacts in scope each holds. */
  folders: (query: string, scope: SearchScope, limit: number) => NameHit[];
};

export function createSearchStore(options: { database: Database }): SearchStore {
  const { database } = options;

  // A tag or folder with no artifact in scope still matches, with a count of 0.
  const names =
    (table: "tags" | "folders") => (query: string, scope: SearchScope, limit: number) => {
      const words = queryWords(query);
      if (words.length === 0) return [];
      const { conditions, parameters } = scopeConditions(scope);
      const inScope = conditions.join(" and ");
      const filed =
        table === "tags"
          ? `left join (artifactTags join artifacts
               on artifacts.id = artifactTags.artifactId and ${inScope})
             on artifactTags.tagId = tags.id`
          : `left join artifacts on artifacts.folderId = folders.id and ${inScope}`;
      // Words hold only letters and digits, so none is a LIKE wildcard.
      return database
        .query(
          `select ${table}.id, ${table}.name, count(artifacts.id) as count
         from ${table} ${filed}
         where ${words.map(() => `${table}.name like ?`).join(" and ")}
         group by ${table}.id order by count desc, ${table}.name collate nocase limit ?`,
        )
        .all(...parameters, ...words.map((word) => `%${word}%`), limit) as NameHit[];
    };

  return {
    indexVersion(versionId, text, textVersion) {
      database
        .query(
          `insert into searchDocuments (kind, refId, body, textVersion)
           select 'version', id, ?, ? from artifactVersions where id = ?
           on conflict (kind, refId) do update
             set body = excluded.body, textVersion = excluded.textVersion`,
        )
        .run(text, textVersion, versionId);
    },

    staleVersions(textVersion) {
      const rows = database
        .query(
          `select artifactVersions.id
           from artifacts join artifactVersions
             on artifactVersions.artifactId = artifacts.id
             and artifactVersions.storageKey = artifacts.storageKey
           where not exists (select 1 from searchDocuments
             where kind = 'version' and refId = artifactVersions.id and textVersion = ?)`,
        )
        .all(textVersion) as { id: string }[];
      return rows.map((row) => row.id);
    },

    countArtifacts(query, scope) {
      const matching = matchingArtifactIds(query);
      if (!matching) return 0;
      const { conditions, parameters } = scopeConditions(scope);
      const { count } = database
        .query(
          `select count(*) as count from artifacts
           where artifacts.id in (${matching.sql}) and ${conditions.join(" and ")}`,
        )
        .get(...matching.parameters, ...parameters) as { count: number };
      return count;
    },

    search(kind, query, scope, limit) {
      const words = queryWords(query);
      if (words.length === 0) return [];
      const match = matches(words);
      const { conditions, parameters } = scopeConditions(scope);
      const rows = database
        .query(
          `select searchDocuments.id, searchDocuments.refId, artifacts.id as artifactId,
             searchDocuments.title, searchDocuments.body
           ${kindFrom(kind, match)} and ${conditions.join(" and ")}
           order by ${ORDER[kind]} limit ?`,
        )
        .all(...match.parameters, ...parameters, limit) as (Omit<SearchHit, "stemmed"> & {
        id: number;
      })[];
      // highlight() needs its own match on the porter index. A row that only
      // the prefix index matched has no row here.
      const highlight = database.query(
        `select highlight(searchStemmed, 0, char(2), char(3)) as title,
           highlight(searchStemmed, 1, char(2), char(3)) as body
         from searchStemmed where searchStemmed match ? and rowid = ?`,
      );
      return rows.map(({ id, ...row }) => {
        const marked = highlight.get(stemmedQuery(words), id) as {
          title: string;
          body: string;
        } | null;
        return {
          ...row,
          stemmed: {
            title: marked ? markedRanges(marked.title) : [],
            body: marked ? markedRanges(marked.body) : [],
          },
        };
      });
    },

    tags: names("tags"),
    folders: names("folders"),
  };
}
