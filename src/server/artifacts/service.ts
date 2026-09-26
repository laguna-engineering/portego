import type { EventBus } from "../events/bus.ts";
import { CONVERTER_VERSION, htmlToMarkdown } from "../markdown/convert.ts";
import { markdownToHtml } from "../markdown/render.ts";
import type { CachedMarkdown, MarkdownStore } from "../markdown/store.ts";
import type {
  Artifact,
  ArtifactStatus,
  ArtifactStore,
  ArtifactVersion,
  ListResult,
  ListSort,
  TagMatch,
} from "../storage/artifacts.ts";
import { ContentMissingError, InvalidCursorError } from "../storage/artifacts.ts";
import type { Comment, CommentAnchor, CommentStore } from "../storage/comments.ts";
import type { Entry, EntryStore } from "../storage/entries.ts";
import type { ArtifactOrganization } from "../storage/organization.ts";
import {
  checkEntry,
  ENTRY_KEY_MAX_LENGTH,
  type EntrySchema,
  EntrySchemaError,
  extractEntrySchema,
  isEntryKey,
  parseEntrySchema,
} from "./entry-schema.ts";
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
> &
  ArtifactOrganization & {
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
  /** Markdown is rendered to the stored static HTML document. */
  contentType?: "html" | "markdown";
  /**
   * What an agent reads back in place of Markdown converted from the HTML.
   * Only with an HTML upload; a Markdown upload is already its own text.
   */
  markdown?: string | null;
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
  folderId?: string | null;
  tagIds?: string[];
  tagMatch?: TagMatch;
  includeArchived?: boolean;
};

export const COMMENT_MAX_LENGTH = 4000;
export const ANCHOR_QUOTE_MAX_LENGTH = 500;
export const ANCHOR_CONTEXT_MAX_LENGTH = 100;

/** The JSON text of one entry's value. */
export const ENTRY_VALUE_MAX_BYTES = 4000;
/** Keys one person may hold on one artifact. */
export const ENTRIES_PER_AUTHOR = 200;
/** The JSON text of all values on one artifact, so its list fits in one response. */
export const ENTRY_VALUES_MAX_BYTES = 1024 * 1024;
/** Writes one person may make to one artifact's entries per minute. */
export const ENTRY_WRITES_PER_MINUTE = 60;

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
  /** Every person's entries, and the schema the current version declares. */
  entries: (id: string) => { entries: Entry[]; schema: unknown };
  /** Sets the author's value for a key, replacing any value they had. */
  setEntry: (id: string, input: { authorId: string; key: string; value: unknown }) => Entry;
  /** Removes the author's value for a key. Removing a key they never set is not an error. */
  clearEntry: (id: string, input: { authorId: string; key: string }) => void;
  maxUploadBytes: number;
};

function toSummary(artifact: Artifact, organization?: ArtifactOrganization): ArtifactSummary {
  const { storageKey: _hidden, createdBy, createdByName, createdByEmail, ...summary } = artifact;
  return {
    ...summary,
    creator: { id: createdBy, name: createdByName, email: createdByEmail },
    folder: organization?.folder ?? null,
    tags: organization?.tags ?? [],
  };
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

function toResult(result: ListResult, assignments: Map<string, ArtifactOrganization>) {
  return {
    items: result.items.map((artifact) => toSummary(artifact, assignments.get(artifact.id))),
    nextCursor: result.nextCursor,
  };
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
  entryStore: EntryStore;
  maxUploadBytes?: number;
  /** Where a committed change is announced. Absent in tests that ignore it. */
  events?: EventBus;
  /** Adds shared folder and tag metadata without giving this service write access to it. */
  organization?: { assignments: (artifactIds: string[]) => Map<string, ArtifactOrganization> };
}): ArtifactService {
  const { store, markdownStore, commentStore, entryStore } = options;
  const assignments =
    options.organization?.assignments ?? (() => new Map<string, ArtifactOrganization>());
  const summary = (artifact: Artifact) =>
    toSummary(artifact, assignments([artifact.id]).get(artifact.id));
  const maxUploadBytes = options.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  // Published after the write returns, so a failed write announces nothing.
  const publish = options.events?.publish ?? (() => {});
  const entryWrites = createWriteLimiter(ENTRY_WRITES_PER_MINUTE, 60_000);
  // A version's schema never changes, so each one is parsed once.
  const entrySchemas = new Map<string, EntrySchema | null>();
  const entrySchema = (versionId: string): EntrySchema | null => {
    let schema = entrySchemas.get(versionId);
    if (schema === undefined) {
      const text = entryStore.schema(versionId);
      schema = text === null ? null : parseEntrySchema(text);
      entrySchemas.set(versionId, schema);
    }
    return schema;
  };

  const writableKey = (id: string, key: string) => {
    const artifact = store.get(id);
    if (!artifact) throw new ServiceError("NOT_FOUND", "No such artifact.");
    if (!isEntryKey(key)) {
      throw new ServiceError(
        "INVALID_INPUT",
        `A key is 1 to ${ENTRY_KEY_MAX_LENGTH} printable characters with no spaces.`,
      );
    }
    return artifact;
  };

  const limitWrites = (id: string, authorId: string) => {
    if (!entryWrites.allow(`${id} ${authorId}`)) {
      throw new ServiceError(
        "RATE_LIMITED",
        `At most ${ENTRY_WRITES_PER_MINUTE} entry changes a minute. Try again shortly.`,
      );
    }
  };

  return {
    maxUploadBytes,

    list(input = {}) {
      try {
        const result = store.list(input);
        return toResult(result, assignments(result.items.map((artifact) => artifact.id)));
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
      return summary(artifact);
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
      const isMarkdown = input.contentType === "markdown";
      if (!isMarkdown && !looksLikeHtml(text)) {
        throw new ServiceError(
          "UNSUPPORTED_CONTENT",
          "The file does not look like an HTML document.",
        );
      }
      const companion = input.markdown?.trim() ? input.markdown : null;
      if (companion !== null && isMarkdown) {
        throw new ServiceError(
          "INVALID_INPUT",
          "A Markdown upload is already its own text; send markdown only with HTML.",
        );
      }
      if (companion !== null && Buffer.byteLength(companion) > maxUploadBytes) {
        throw new ServiceError(
          "FILE_TOO_LARGE",
          `The Markdown is larger than the ${maxUploadBytes} byte limit.`,
        );
      }
      const providedMarkdown = isMarkdown ? text : companion;

      // An explicit target is checked before anything is written, so a wrong
      // id is refused rather than turned into a new artifact.
      let target: Artifact | null = null;
      if (input.artifactId) {
        target = store.get(input.artifactId);
        if (!target) throw new ServiceError("NOT_FOUND", "No such artifact.");
      }

      const title = readTitle(input.title, text, isMarkdown, target?.title);
      const description = readDescription(input.description);
      const content = isMarkdown
        ? new TextEncoder().encode(await markdownToHtml(text, title))
        : input.bytes;
      if (content.byteLength > maxUploadBytes) {
        throw new ServiceError(
          "FILE_TOO_LARGE",
          `The rendered HTML is larger than the ${maxUploadBytes} byte limit.`,
        );
      }
      const entrySchema = isMarkdown ? null : readEntrySchema(text);
      const originalFilename = safeFilename(
        isMarkdown
          ? `${input.filename?.replace(/\.[^.]*$/, "") || "artifact"}.html`
          : input.filename,
      );

      if (!target) target = store.findByTitle(title);

      if (target) {
        const artifact = await store.addVersion({
          artifactId: target.id,
          // A version upload without a description keeps the one it has.
          ...(description === null ? {} : { description }),
          originalFilename,
          content,
          ...(providedMarkdown === null ? {} : { providedMarkdown }),
          entrySchema,
          createdBy: input.createdBy,
        });
        if (!artifact) throw new ServiceError("NOT_FOUND", "No such artifact.");
        publish({ type: "artifact.changed", id: artifact.id });
        return { artifact: summary(artifact), newArtifact: false };
      }

      const artifact = await store.create({
        title,
        description,
        originalFilename,
        content,
        ...(providedMarkdown === null ? {} : { providedMarkdown }),
        entrySchema,
        createdBy: input.createdBy,
      });
      publish({ type: "artifact.created", id: artifact.id });
      return { artifact: summary(artifact), newArtifact: true };
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
      return summary(artifact);
    },

    setArchived(id, archived, actorId) {
      const artifact = store.setArchived(id, archived, actorId);
      if (!artifact) throw new ServiceError("NOT_FOUND", "No such artifact.");
      publish({ type: "artifact.changed", id });
      return summary(artifact);
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

    entries(id) {
      const artifact = store.get(id);
      if (!artifact) throw new ServiceError("NOT_FOUND", "No such artifact.");
      const schema = entryStore.schema(artifact.currentVersionId);
      return { entries: entryStore.list(id), schema: schema === null ? null : JSON.parse(schema) };
    },

    setEntry(id, input) {
      const artifact = writableKey(id, input.key);
      if (input.value === undefined) throw new ServiceError("INVALID_INPUT", "Give a value.");
      const value = JSON.stringify(input.value);
      if (Buffer.byteLength(value) > ENTRY_VALUE_MAX_BYTES) {
        throw new ServiceError(
          "INVALID_INPUT",
          `A value is at most ${ENTRY_VALUE_MAX_BYTES} bytes of JSON.`,
        );
      }
      // Entries belong to the artifact, so the current version's schema is the
      // one they have to fit, whichever version the writer is looking at.
      const schema = entrySchema(artifact.currentVersionId);
      if (schema !== null) {
        const problem = checkEntry(schema, input.key, input.value);
        if (problem) throw new ServiceError("INVALID_INPUT", problem);
      }
      const existing = entryStore.get(id, input.authorId, input.key);
      if (!existing && entryStore.count(id, input.authorId) >= ENTRIES_PER_AUTHOR) {
        throw new ServiceError(
          "INVALID_INPUT",
          `One person can hold at most ${ENTRIES_PER_AUTHOR} entries on an artifact.`,
        );
      }
      const otherBytes = entryStore.valueBytes(id, { authorId: input.authorId, key: input.key });
      if (otherBytes + Buffer.byteLength(value) > ENTRY_VALUES_MAX_BYTES) {
        throw new ServiceError(
          "INVALID_INPUT",
          `An artifact's entry values are at most ${ENTRY_VALUES_MAX_BYTES} bytes of JSON together.`,
        );
      }
      limitWrites(id, input.authorId);
      const entry = entryStore.set({
        artifactId: id,
        authorId: input.authorId,
        key: input.key,
        value,
      });
      publish({ type: "entry.changed", artifactId: id });
      return entry;
    },

    clearEntry(id, input) {
      writableKey(id, input.key);
      limitWrites(id, input.authorId);
      if (entryStore.remove(id, input.authorId, input.key)) {
        publish({ type: "entry.changed", artifactId: id });
      }
    },

    async markdown(id, versionId) {
      const artifact = store.get(id);
      if (!artifact) throw new ServiceError("NOT_FOUND", "No such artifact.");
      const version = requireVersion(store, id, versionId ?? artifact.currentVersionId);

      const provided = markdownStore.readProvided(version.id);
      if (provided) return { artifact: summary(artifact), ...provided };

      const cached = markdownStore.read(version.id, version.sha256, CONVERTER_VERSION);
      if (cached) return { artifact: summary(artifact), ...cached };

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
      return { artifact: summary(artifact), ...stored };
    },

    async source(id, versionId) {
      const artifact = store.get(id);
      if (!artifact) throw new ServiceError("NOT_FOUND", "No such artifact.");
      const version = requireVersion(store, id, versionId ?? artifact.currentVersionId);
      const content = await readSource(store, version.id);
      return { artifact: summary(artifact), version: toVersionSummary(version), content };
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

function readTitle(
  given: string | null | undefined,
  text: string,
  isMarkdown: boolean,
  targetTitle?: string,
): string {
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
  const derived = isMarkdown ? titleFromMarkdown(text) : titleFromHtml(text);
  if (derived) return derived;
  if (targetTitle) return targetTitle;
  throw new ServiceError(
    "TITLE_REQUIRED",
    isMarkdown
      ? "Give the artifact a title, or start the Markdown with a heading."
      : "Give the artifact a title, or upload a document with a <title> element.",
  );
}

function titleFromMarkdown(markdown: string): string | null {
  const heading = markdown.match(/^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/m)?.[1]?.trim();
  return heading?.slice(0, TITLE_MAX_LENGTH) || null;
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

/** The checked schema text a page declares, or null. A broken schema refuses the upload. */
function readEntrySchema(html: string): string | null {
  try {
    const text = extractEntrySchema(html);
    if (text !== null) parseEntrySchema(text);
    return text;
  } catch (cause) {
    if (cause instanceof EntrySchemaError) {
      throw new ServiceError("INVALID_INPUT", `The portego-entries schema: ${cause.message}`);
    }
    throw cause;
  }
}

/**
 * Counts writes per key in a sliding window. In memory, like the event bus:
 * one process serves every client.
 */
function createWriteLimiter(limit: number, windowMs: number) {
  const recent = new Map<string, number[]>();
  return {
    allow(key: string): boolean {
      const now = Date.now();
      if (recent.size > 10_000) {
        for (const [other, times] of recent) {
          if (times.every((time) => now - time >= windowMs)) recent.delete(other);
        }
      }
      const times = (recent.get(key) ?? []).filter((time) => now - time < windowMs);
      if (times.length >= limit) {
        recent.set(key, times);
        return false;
      }
      times.push(now);
      recent.set(key, times);
      return true;
    },
  };
}
