import type { EventBus } from "../events/bus.ts";
import { CONVERTER_VERSION, htmlToMarkdown } from "../markdown/convert.ts";
import type { CachedMarkdown, MarkdownStore } from "../markdown/store.ts";
import type {
  Artifact,
  ArtifactStatus,
  ArtifactStore,
  ArtifactVersion,
  ListResult,
  ListSort,
} from "../storage/artifacts.ts";
import { ContentMissingError, InvalidCursorError } from "../storage/artifacts.ts";
import type { Comment, CommentAnchor, CommentStore } from "../storage/comments.ts";
import { ServiceError } from "./errors.ts";
import {
  DESCRIPTION_MAX_LENGTH,
  decodeUtf8,
  looksLikeHtml,
  safeFilename,
  TITLE_MAX_LENGTH,
  titleFromHtml,
} from "./html.ts";

/** 5 MiB. Documented in the README and in the MCP tool descriptions. */
export const DEFAULT_MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** What a client is allowed to see. The storage key stays on the server. */
export type ArtifactSummary = Omit<
  Artifact,
  "storageKey" | "createdBy" | "createdByName" | "createdByEmail"
> & {
  /** Who uploaded it. A name, because a card shows a person and not an id. */
  creator: { id: string; name: string; email: string };
};

export type VersionSummary = Omit<
  ArtifactVersion,
  "artifactId" | "storageKey" | "createdBy" | "createdByName" | "createdByEmail"
> & {
  creator: { id: string; name: string; email: string };
};

export type UploadInput = {
  bytes: Uint8Array;
  /** Hints from the request. The stored name comes from the first of these. */
  filename?: string | null;
  title?: string | null;
  description?: string | null;
  /**
   * The artifact this upload is a new version of. Without it, an upload whose
   * title matches an existing artifact's title becomes a new version of that
   * artifact.
   */
  artifactId?: string | null;
  /** Taken from the session, never from the request body. */
  createdBy: string;
};

export type UploadResult = {
  artifact: ArtifactSummary;
  /** False when the upload became a new version of an existing artifact. */
  newArtifact: boolean;
};

export type ListInput = {
  query?: string | null;
  cursor?: string | null;
  sort?: ListSort | null;
  limit?: number;
  status?: ArtifactStatus | null;
  includeArchived?: boolean;
};

export const COMMENT_MAX_LENGTH = 4000;
export const ANCHOR_QUOTE_MAX_LENGTH = 500;
export const ANCHOR_CONTEXT_MAX_LENGTH = 100;

/**
 * Anchors arrive as untrusted JSON (an HTTP body or an MCP tool argument), so
 * this checks the shape as well as the limits. A comment with no anchor at
 * all is valid; one with a malformed anchor is refused.
 */
function validateAnchor(anchor: unknown): CommentAnchor | null {
  if (anchor === undefined || anchor === null) return null;
  if (typeof anchor !== "object") {
    throw new ServiceError(
      "INVALID_INPUT",
      "An anchor is an object with quote, prefix, and suffix.",
    );
  }
  const { quote, prefix, suffix } = anchor as Record<string, unknown>;
  if (typeof quote !== "string" || typeof prefix !== "string" || typeof suffix !== "string") {
    throw new ServiceError(
      "INVALID_INPUT",
      "anchor.quote, anchor.prefix, and anchor.suffix must be strings.",
    );
  }
  const trimmedQuote = quote.trim();
  if (trimmedQuote === "") {
    throw new ServiceError("INVALID_INPUT", "anchor.quote cannot be empty.");
  }
  if (trimmedQuote.length > ANCHOR_QUOTE_MAX_LENGTH) {
    throw new ServiceError(
      "INVALID_INPUT",
      `anchor.quote is at most ${ANCHOR_QUOTE_MAX_LENGTH} characters.`,
    );
  }
  if (prefix.length > ANCHOR_CONTEXT_MAX_LENGTH || suffix.length > ANCHOR_CONTEXT_MAX_LENGTH) {
    throw new ServiceError(
      "INVALID_INPUT",
      `anchor.prefix and anchor.suffix are at most ${ANCHOR_CONTEXT_MAX_LENGTH} characters.`,
    );
  }
  return { quote: trimmedQuote, prefix, suffix };
}

export type ArtifactService = {
  list: (input?: ListInput) => { items: ArtifactSummary[]; nextCursor: string | null };
  get: (id: string) => ArtifactSummary;
  upload: (input: UploadInput) => Promise<UploadResult>;
  /** Highest number first. */
  versions: (id: string) => VersionSummary[];
  /** One version's bytes. Without a version id, the current one. */
  source: (
    id: string,
    versionId?: string | null,
  ) => Promise<{ artifact: ArtifactSummary; version: VersionSummary; content: Uint8Array }>;
  /** A version's static content as Markdown. Converted once, then reused. */
  markdown: (
    id: string,
    versionId?: string | null,
  ) => Promise<{ artifact: ArtifactSummary } & CachedMarkdown>;
  setStatus: (id: string, status: ArtifactStatus, actorId: string) => ArtifactSummary;
  setArchived: (id: string, archived: boolean, actorId: string) => ArtifactSummary;
  comments: (id: string) => Comment[];
  addComment: (
    id: string,
    input: {
      authorId: string;
      body: string;
      anchor?: unknown;
      parentId?: string | null;
      /** The version the comment was written on. Defaults to the current one. */
      versionId?: string | null;
    },
  ) => Comment;
  deleteComment: (id: string, commentId: string, actorId: string) => void;
  maxUploadBytes: number;
};

function toSummary(artifact: Artifact): ArtifactSummary {
  const { storageKey: _hidden, createdBy, createdByName, createdByEmail, ...summary } = artifact;
  return { ...summary, creator: { id: createdBy, name: createdByName, email: createdByEmail } };
}

function toVersionSummary(version: ArtifactVersion): VersionSummary {
  const {
    artifactId: _artifact,
    storageKey: _hidden,
    createdBy,
    createdByName,
    createdByEmail,
    ...summary
  } = version;
  return { ...summary, creator: { id: createdBy, name: createdByName, email: createdByEmail } };
}

function toResult(result: ListResult) {
  return { items: result.items.map(toSummary), nextCursor: result.nextCursor };
}

/**
 * Everything the transports share. The HTTP routes and the MCP tools call
 * these methods; neither of them talks to storage, and neither repeats a rule
 * the other has to keep in step.
 */
export function createArtifactService(options: {
  store: ArtifactStore;
  markdownStore: MarkdownStore;
  commentStore: CommentStore;
  maxUploadBytes?: number;
  /** Where a committed change is announced. Absent in tests that ignore it. */
  events?: EventBus;
}): ArtifactService {
  const { store, markdownStore, commentStore } = options;
  const maxUploadBytes = options.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  // Published after the write returns, so a failed write announces nothing.
  const publish = options.events?.publish ?? (() => {});

  return {
    maxUploadBytes,

    list(input = {}) {
      try {
        return toResult(store.list(input));
      } catch (cause) {
        if (cause instanceof InvalidCursorError) {
          throw new ServiceError("INVALID_CURSOR", "The pagination cursor is not valid.");
        }
        throw cause;
      }
    },

    get(id) {
      const artifact = store.get(id);
      if (!artifact) throw new ServiceError("NOT_FOUND", "No such artifact.");
      return toSummary(artifact);
    },

    async upload(input) {
      if (input.bytes.byteLength === 0) {
        throw new ServiceError("INVALID_INPUT", "The file is empty.");
      }
      if (input.bytes.byteLength > maxUploadBytes) {
        throw new ServiceError(
          "FILE_TOO_LARGE",
          `The file is larger than the ${maxUploadBytes} byte limit.`,
        );
      }

      const text = decodeUtf8(input.bytes);
      if (!looksLikeHtml(text)) {
        throw new ServiceError(
          "UNSUPPORTED_CONTENT",
          "The file does not look like an HTML document.",
        );
      }

      const title = readTitle(input.title, text);
      const description = readDescription(input.description);
      const originalFilename = safeFilename(input.filename);

      // An explicit target is checked before anything is written, so a wrong
      // id is refused rather than turned into a new artifact.
      let target: Artifact | null = null;
      if (input.artifactId) {
        target = store.get(input.artifactId);
        if (!target) throw new ServiceError("NOT_FOUND", "No such artifact.");
      } else {
        target = store.findByTitle(title);
      }

      if (target) {
        const artifact = await store.addVersion({
          artifactId: target.id,
          // A version upload without a description keeps the one it has.
          ...(description === null ? {} : { description }),
          originalFilename,
          content: input.bytes,
          createdBy: input.createdBy,
        });
        if (!artifact) throw new ServiceError("NOT_FOUND", "No such artifact.");
        publish({ type: "artifact.changed", id: artifact.id });
        return { artifact: toSummary(artifact), newArtifact: false };
      }

      const artifact = await store.create({
        title,
        description,
        originalFilename,
        content: input.bytes,
        createdBy: input.createdBy,
      });
      publish({ type: "artifact.created", id: artifact.id });
      return { artifact: toSummary(artifact), newArtifact: true };
    },

    versions(id) {
      if (!store.get(id)) throw new ServiceError("NOT_FOUND", "No such artifact.");
      return store.versions(id).map(toVersionSummary);
    },

    // Every admitted user may move an artifact's status, archive it, restore
    // it, and comment on it. There are no roles here, so the record of who did
    // what is what matters, and every change carries the actor.
    setStatus(id, status, actorId) {
      const artifact = store.setStatus(id, status, actorId);
      if (!artifact) throw new ServiceError("NOT_FOUND", "No such artifact.");
      publish({ type: "artifact.changed", id });
      return toSummary(artifact);
    },

    setArchived(id, archived, actorId) {
      const artifact = store.setArchived(id, archived, actorId);
      if (!artifact) throw new ServiceError("NOT_FOUND", "No such artifact.");
      publish({ type: "artifact.changed", id });
      return toSummary(artifact);
    },

    comments(id) {
      if (!store.get(id)) throw new ServiceError("NOT_FOUND", "No such artifact.");
      return commentStore.list(id);
    },

    addComment(id, input) {
      const artifact = store.get(id);
      if (!artifact) throw new ServiceError("NOT_FOUND", "No such artifact.");
      const body = input.body.trim();
      if (body === "") throw new ServiceError("INVALID_INPUT", "Write something first.");
      if (body.length > COMMENT_MAX_LENGTH) {
        throw new ServiceError(
          "INVALID_INPUT",
          `A comment is at most ${COMMENT_MAX_LENGTH} characters.`,
        );
      }
      const anchor = validateAnchor(input.anchor);
      const parentId = input.parentId ?? null;
      let versionId = input.versionId ?? artifact.currentVersionId;
      if (parentId !== null) {
        if (anchor) {
          throw new ServiceError("INVALID_INPUT", "A reply belongs to its thread's passage.");
        }
        const parent = commentStore.get(parentId);
        if (!parent || parent.artifactId !== id) {
          throw new ServiceError("NOT_FOUND", "That comment does not exist.");
        }
        if (parent.parentId !== null) {
          throw new ServiceError("INVALID_INPUT", "Reply to the comment that started the thread.");
        }
        // A thread stays on the version it started on.
        versionId = parent.versionId;
      } else if (versionId !== artifact.currentVersionId) {
        requireVersion(store, id, versionId);
      }
      const comment = commentStore.add({
        artifactId: id,
        versionId,
        authorId: input.authorId,
        body,
        anchor,
        parentId,
      });
      publish({ type: "comment.changed", artifactId: id });
      return comment;
    },

    deleteComment(id, commentId, actorId) {
      const comment = commentStore.get(commentId);
      if (!comment || comment.artifactId !== id) {
        throw new ServiceError("NOT_FOUND", "No such comment.");
      }
      // A comment cannot be edited. Its author can remove it; nobody else can.
      if (comment.author.id !== actorId) {
        throw new ServiceError("FORBIDDEN", "Only the author can remove a comment.");
      }
      // The guard above and the store's own author condition have to agree.
      // If they ever stop agreeing, say so rather than report a delete that
      // did not happen.
      if (!commentStore.remove(commentId, actorId)) {
        throw new ServiceError("NOT_FOUND", "No such comment.");
      }
      publish({ type: "comment.changed", artifactId: id });
    },

    async markdown(id, versionId) {
      const artifact = store.get(id);
      if (!artifact) throw new ServiceError("NOT_FOUND", "No such artifact.");
      const version = requireVersion(store, id, versionId ?? artifact.currentVersionId);

      const cached = markdownStore.read(version.id, version.sha256, CONVERTER_VERSION);
      if (cached) return { artifact: toSummary(artifact), ...cached };

      const content = await readSource(store, version.id);
      // Parsing only. The document's own scripts are dropped, never run.
      const converted = htmlToMarkdown(new TextDecoder().decode(content));
      const stored = markdownStore.write({
        versionId: version.id,
        sourceSha256: version.sha256,
        converterVersion: CONVERTER_VERSION,
        markdown: converted.markdown,
        empty: converted.empty,
      });
      return { artifact: toSummary(artifact), ...stored };
    },

    async source(id, versionId) {
      const artifact = store.get(id);
      if (!artifact) throw new ServiceError("NOT_FOUND", "No such artifact.");
      const version = requireVersion(store, id, versionId ?? artifact.currentVersionId);
      const content = await readSource(store, version.id);
      return { artifact: toSummary(artifact), version: toVersionSummary(version), content };
    },
  };
}

/** The version, which has to belong to the artifact it was asked for under. */
function requireVersion(store: ArtifactStore, artifactId: string, versionId: string) {
  const version = store.getVersion(versionId);
  if (!version || version.artifactId !== artifactId) {
    throw new ServiceError("NOT_FOUND", "No such version of this artifact.");
  }
  return version;
}

/** One version's stored bytes, with a missing file reported as such. */
async function readSource(store: ArtifactStore, versionId: string): Promise<Uint8Array> {
  try {
    const result = await store.readVersionContent(versionId);
    if (!result) throw new ServiceError("NOT_FOUND", "No such version of this artifact.");
    return result.content;
  } catch (cause) {
    if (cause instanceof ContentMissingError) {
      throw new ServiceError("CONTENT_MISSING", "This artifact's content is not available.");
    }
    throw cause;
  }
}

function readTitle(given: string | null | undefined, text: string): string {
  const provided = given?.trim();
  if (provided) {
    if (provided.length > TITLE_MAX_LENGTH) {
      throw new ServiceError(
        "INVALID_INPUT",
        `The title is longer than ${TITLE_MAX_LENGTH} characters.`,
      );
    }
    return provided;
  }
  // A derived title is truncated rather than refused: the uploader did not
  // write it and cannot be asked to shorten it.
  const derived = titleFromHtml(text);
  if (!derived) {
    throw new ServiceError(
      "TITLE_REQUIRED",
      "Give the artifact a title, or upload a document with a <title> element.",
    );
  }
  return derived;
}

function readDescription(given: string | null | undefined): string | null {
  const description = given?.trim();
  if (!description) return null;
  if (description.length > DESCRIPTION_MAX_LENGTH) {
    throw new ServiceError(
      "INVALID_INPUT",
      `The description is longer than ${DESCRIPTION_MAX_LENGTH} characters.`,
    );
  }
  return description;
}
