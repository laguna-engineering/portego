import type { Database } from "bun:sqlite";
import { JOIN_DISPLAY_NAME, USER_NAME } from "./names.ts";
import { follow } from "./subscriptions.ts";

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
  /** The service sends a null email to a guest. */
  author: { id: string; name: string; email: string | null };
  anchor: CommentAnchor | null;
  /** The root comment this replies to, or null for a root comment itself. */
  parentId: string | null;
  /** The version whose text the comment was written on. */
  versionId: string;
  versionNumber: number;
  /** Written in the web app, not by an agent. */
  inApp: boolean;
  /** Set on a root comment whose thread is solved. Always null on a reply. */
  solved: { at: Date; by: { id: string; name: string } } | null;
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
    /** Made in the web app, not by an agent. */
    inApp?: boolean;
  }) => Comment;
  get: (id: string) => Comment | null;
  /** Removes a comment. Returns false when it is not this author's to remove. */
  remove: (id: string, authorId: string) => boolean;
  /**
   * Marks a root comment's thread solved or open again, recording the change
   * only when the state moves. Null when there is no such comment.
   */
  setSolved: (
    id: string,
    solved: boolean,
    actorId: string,
    options?: { inApp?: boolean },
  ) => Comment | null;
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
  inApp: number;
  solvedAt: number | null;
  solvedBy: string | null;
  solverName: string | null;
};

const SELECT_COMMENT = `
  select artifactComments.*, ${USER_NAME} as authorName, "user".email as authorEmail,
    artifactVersions.number as versionNumber,
    coalesce(solverDisplayName.name, solver.name) as solverName
  from artifactComments
    join "user" on "user".id = artifactComments.authorId
    ${JOIN_DISPLAY_NAME}
    join artifactVersions on artifactVersions.id = artifactComments.versionId
    left join "user" solver on solver.id = artifactComments.solvedBy
    left join userDisplayNames solverDisplayName on solverDisplayName.userId = solver.id`;

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
    inApp: row.inApp === 1,
    solved:
      row.solvedAt !== null && row.solvedBy !== null
        ? { at: new Date(row.solvedAt), by: { id: row.solvedBy, name: row.solverName ?? "" } }
        : null,
  };
}

/**
 * Comments are append-only rows. Two people commenting at the same time write
 * two rows, so neither can overwrite the other, and nothing has to be merged.
 * Text and creation time are immutable; an author may remove their own comment.
 * A thread's solved state lives on its root and changes in place.
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
      const now = Date.now();
      const anchor = input.anchor ?? null;
      const anchorJson = anchor
        ? JSON.stringify({ quote: anchor.quote, prefix: anchor.prefix, suffix: anchor.suffix })
        : null;
      database.transaction(() => {
        database
          .query(
            `insert into artifactComments
               (id, artifactId, versionId, authorId, body, createdAt, anchor, parentId, inApp)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            input.artifactId,
            input.versionId,
            input.authorId,
            input.body,
            now,
            anchorJson,
            input.parentId ?? null,
            input.inApp ? 1 : 0,
          );
        follow(database, {
          userId: input.authorId,
          artifactId: input.artifactId,
          reason: "commented",
          at: now,
        });
        // A reply reopens a solved thread. The reply itself reaches the
        // thread's author, so no separate reopen is recorded.
        if (input.parentId) {
          database
            .query("update artifactComments set solvedAt = null, solvedBy = null where id = ?")
            .run(input.parentId);
        }
      })();
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

    setSolved(id, solved, actorId, options = {}) {
      const now = Date.now();
      database.transaction(() => {
        const before = get(id);
        if (!before || (before.solved !== null) === solved) return;
        database
          .query("update artifactComments set solvedAt = ?, solvedBy = ? where id = ?")
          .run(solved ? now : null, solved ? actorId : null, id);
        database
          .query(
            `insert into commentStatusChanges
               (id, artifactId, commentId, change, actorId, createdAt, inApp)
             values (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            Bun.randomUUIDv7(),
            before.artifactId,
            id,
            solved ? "solved" : "reopened",
            actorId,
            now,
            options.inApp ? 1 : 0,
          );
      })();
      return get(id);
    },
  };
}
