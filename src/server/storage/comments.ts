import type { Database } from "bun:sqlite";

/**
 * Points a comment at a passage of the artifact's rendered text. `quote` is
 * the selected text; `prefix` and `suffix` are short runs of text around it
 * that disambiguate which occurrence was selected when the quote repeats.
 */
export type CommentAnchor = { quote: string; prefix: string; suffix: string };

export type Comment = {
  id: string;
  artifactId: string;
  body: string;
  createdAt: Date;
  author: { id: string; name: string; email: string };
  anchor: CommentAnchor | null;
  /** The root comment this replies to, or null for a root comment itself. */
  parentId: string | null;
  /** The version whose text the comment was written on. */
  versionId: string;
  versionNumber: number;
};

export type CommentStore = {
  list: (artifactId: string) => Comment[];
  add: (input: {
    artifactId: string;
    versionId: string;
    authorId: string;
    body: string;
    anchor?: CommentAnchor | null;
    parentId?: string | null;
  }) => Comment;
  get: (id: string) => Comment | null;
  /** Removes a comment. Returns false when it is not this author's to remove. */
  remove: (id: string, authorId: string) => boolean;
};

type Row = {
  id: string;
  artifactId: string;
  body: string;
  createdAt: number;
  authorId: string;
  authorName: string;
  authorEmail: string;
  anchor: string | null;
  parentId: string | null;
  versionId: string;
  versionNumber: number;
};

const SELECT_COMMENT = `
  select artifactComments.*, "user".name as authorName, "user".email as authorEmail,
    artifactVersions.number as versionNumber
  from artifactComments
    join "user" on "user".id = artifactComments.authorId
    join artifactVersions on artifactVersions.id = artifactComments.versionId`;

function toComment(row: Row): Comment {
  return {
    id: row.id,
    artifactId: row.artifactId,
    body: row.body,
    createdAt: new Date(row.createdAt),
    author: { id: row.authorId, name: row.authorName, email: row.authorEmail },
    anchor: row.anchor ? (JSON.parse(row.anchor) as CommentAnchor) : null,
    parentId: row.parentId,
    versionId: row.versionId,
    versionNumber: row.versionNumber,
  };
}

/**
 * Comments are append-only rows. Two people commenting at the same time write
 * two rows, so neither can overwrite the other, and nothing has to be merged.
 * Text and creation time are immutable; an author may remove their own comment.
 */
export function createCommentStore(options: { database: Database }): CommentStore {
  const { database } = options;

  const get = (id: string): Comment | null => {
    const row = database
      .query(`${SELECT_COMMENT} where artifactComments.id = ?`)
      .get(id) as Row | null;
    return row ? toComment(row) : null;
  };

  return {
    get,

    list(artifactId) {
      const rows = database
        .query(
          `${SELECT_COMMENT} where artifactComments.artifactId = ?
           order by artifactComments.createdAt, artifactComments.id`,
        )
        .all(artifactId) as Row[];
      return rows.map(toComment);
    },

    add(input) {
      const id = Bun.randomUUIDv7();
      const anchor = input.anchor ?? null;
      const anchorJson = anchor
        ? JSON.stringify({ quote: anchor.quote, prefix: anchor.prefix, suffix: anchor.suffix })
        : null;
      database
        .query(
          `insert into artifactComments
             (id, artifactId, versionId, authorId, body, createdAt, anchor, parentId)
           values (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.artifactId,
          input.versionId,
          input.authorId,
          input.body,
          Date.now(),
          anchorJson,
          input.parentId ?? null,
        );
      const comment = get(id);
      if (!comment) throw new Error(`Comment ${id} disappeared right after it was written`);
      return comment;
    },

    remove(id, authorId) {
      const result = database
        .query("delete from artifactComments where id = ? and authorId = ?")
        .run(id, authorId);
      return result.changes > 0;
    },
  };
}
