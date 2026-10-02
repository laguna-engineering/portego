import type { EventBus } from "../events/bus.ts";
import { CONVERTER_VERSION, htmlToMarkdown } from "../markdown/convert.ts";
import { markdownToHtml } from "../markdown/render.ts";
import type { CachedMarkdown, MarkdownStore } from "../markdown/store.ts";
import type { OrganizationService } from "../organization/service.ts";
import type {
  Artifact,
  ArtifactStatus,
  ArtifactStore,
  ArtifactVersion,
  ArtifactVisibility,
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
import {
  checkImages,
  DEFAULT_MAX_IMAGE_BYTES_TOTAL,
  DEFAULT_MAX_IMAGES,
  type UploadedImage,
} from "./images.ts";

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

/** Who a read is for. Null is someone with no session, who sees shared artifacts only. */
export type Viewer = { userId: string | null };

const VISIBILITIES: readonly ArtifactVisibility[] = ["shared", "private"];

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
   * The artifact this upload is a new version of. Without it, the upload
   * creates an artifact, and a title that an existing artifact already has is
   * refused unless allowDuplicateTitle is set.
   */
  artifactId?: string | null;
  allowDuplicateTitle?: boolean;
  /** Filed as with setArtifactOrganization. Omitted keeps a new version's folder and tags. */
  folderId?: unknown;
  tagIds?: unknown;
  /** Set as with setVisibility. Omitted makes a new artifact shared and keeps a version's. */
  visibility?: unknown;
  /** Files the HTML loads as images/<name>. Only with an HTML upload. */
  images?: UploadedImage[];
  /** Taken from the session, never from the request body. */
  createdBy: string;
  /** Made in the web app, not by an agent or a ticket. */
  inApp?: boolean;
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

/**
 * Every method that takes an artifact id refuses with PRIVATE when the
 * artifact is someone else's private one. Reads take the viewer; writes use
 * the actor.
 */
export type ArtifactService = {
  list: (
    viewer: Viewer,
    input?: ListInput,
  ) => { items: ArtifactSummary[]; nextCursor: string | null };
  get: (id: string, viewer: Viewer) => ArtifactSummary;
  upload: (input: UploadInput) => Promise<UploadResult>;
  /** Highest number first. */
  versions: (id: string, viewer: Viewer) => VersionSummary[];
  /** One version's bytes. Without a version id, the current one. */
  source: (
    id: string,
    viewer: Viewer,
    versionId?: string | null,
  ) => Promise<{ artifact: ArtifactSummary; version: VersionSummary; content: Uint8Array }>;
  /** One image of a version, by the name its HTML uses. */
  image: (
    id: string,
    viewer: Viewer,
    versionId: string,
    name: string,
  ) => Promise<{ contentType: string; content: Uint8Array }>;
  /** A version's static content as Markdown. Converted once, then reused. */
  markdown: (
    id: string,
    viewer: Viewer,
    versionId?: string | null,
  ) => Promise<{ artifact: ArtifactSummary } & CachedMarkdown>;
  /** Only the artifact's creator can change its visibility. */
  setVisibility: (id: string, visibility: unknown, actorId: string) => ArtifactSummary;
  setStatus: (
    id: string,
    status: ArtifactStatus,
    actorId: string,
    options?: { inApp?: boolean },
  ) => ArtifactSummary;
  setArchived: (
    id: string,
    archived: boolean,
    actorId: string,
    options?: { inApp?: boolean },
  ) => ArtifactSummary;
  comments: (id: string, viewer: Viewer) => Comment[];
  addComment: (
    id: string,
    input: {
      authorId: string;
      body: string;
      anchor?: unknown;
      parentId?: string | null;
      /** The version the comment was written on. Defaults to the current one. */
      versionId?: string | null;
      /** Made in the web app, not by an agent. */
      inApp?: boolean;
    },
  ) => Comment;
  deleteComment: (id: string, commentId: string, actorId: string) => void;
  /** Every person's entries, and the schema the current version declares. */
  entries: (id: string, viewer: Viewer) => { entries: Entry[]; schema: unknown };
  /** Sets the author's value for a key, replacing any value they had. */
  setEntry: (id: string, input: { authorId: string; key: string; value: unknown }) => Entry;
  /** Removes the author's value for a key. Removing a key they never set is not an error. */
  clearEntry: (id: string, input: { authorId: string; key: string }) => void;
  maxUploadBytes: number;
  maxImages: number;
  maxImageBytesTotal: number;
  /** False when the deployment turned private artifacts off. */
  privateArtifacts: boolean;
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
  maxImages?: number;
  maxImageBytesTotal?: number;
  /**
   * False refuses to make an artifact private. Throws when private artifacts
   * already exist, because they would otherwise stay hidden. Defaults to true.
   */
  privateArtifacts?: boolean;
  /** Where a committed change is announced. Absent in tests that ignore it. */
  events?: EventBus;
  /** Adds shared folder and tag metadata, and files an upload that asks for it. */
  organization?: Pick<
    OrganizationService,
    "assignments" | "checkAssignment" | "setArtifactOrganization"
  >;
}): ArtifactService {
  const { store, markdownStore, commentStore, entryStore, organization } = options;
  const assignments = organization?.assignments ?? (() => new Map<string, ArtifactOrganization>());
  const summary = (artifact: Artifact) =>
    toSummary(artifact, assignments([artifact.id]).get(artifact.id));
  const maxUploadBytes = options.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  const maxImages = options.maxImages ?? DEFAULT_MAX_IMAGES;
  const maxImageBytesTotal = options.maxImageBytesTotal ?? DEFAULT_MAX_IMAGE_BYTES_TOTAL;
  const privateArtifacts = options.privateArtifacts ?? true;
  if (!privateArtifacts) {
    const count = store.countPrivate();
    if (count > 0) {
      throw new Error(
        `Private artifacts are turned off, but ${count} private artifact(s) exist. ` +
          "Set PRIVATE_ARTIFACTS=true, or make them shared before turning it off.",
      );
    }
  }
  const readVisibility = (visibility: unknown): ArtifactVisibility => {
    const checked = parseVisibility(visibility);
    if (checked === "private" && !privateArtifacts) {
      throw new ServiceError("FORBIDDEN", "This deployment does not allow private artifacts.");
    }
    return checked;
  };
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

  const visible = (id: string, viewer: Viewer): Artifact => {
    const artifact = store.get(id);
    if (!artifact) throw new ServiceError("NOT_FOUND", "No such artifact.");
    if (artifact.visibility === "private" && artifact.createdBy !== viewer.userId) {
      throw new ServiceError("PRIVATE", "This artifact is private.");
    }
    return artifact;
  };

  const writableKey = (id: string, authorId: string, key: string) => {
    const artifact = visible(id, { userId: authorId });
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
    maxImages,
    maxImageBytesTotal,
    privateArtifacts,

    list(viewer, input = {}) {
      try {
        const result = store.list({ ...input, viewerId: viewer.userId });
        return toResult(result, assignments(result.items.map((artifact) => artifact.id)));
      } catch (cause) {
        if (cause instanceof InvalidCursorError) {
          throw new ServiceError("INVALID_CURSOR", "The pagination cursor is not valid.");
        }
        throw cause;
      }
    },

    get(id, viewer) {
      return summary(visible(id, viewer));
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
      const uploadedImages = input.images ?? [];
      // Rendered Markdown shows an image's alt text and never loads it.
      if (isMarkdown && uploadedImages.length > 0) {
        throw new ServiceError("INVALID_INPUT", "Images can only be sent with an HTML upload.");
      }
      const images = checkImages(uploadedImages, {
        maxImages,
        maxTotalBytes: maxImageBytesTotal,
      });
      const visibility =
        input.visibility === undefined ? undefined : readVisibility(input.visibility);

      // An explicit target is checked before anything is written, so a wrong
      // id is refused rather than turned into a new artifact.
      let target: Artifact | null = null;
      if (input.artifactId) {
        target = visible(input.artifactId, { userId: input.createdBy });
        if (visibility !== undefined) requireCreator(target, input.createdBy);
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

      // A shared title alone never selects the artifact to version: that
      // takes an explicit artifactId, and a duplicate takes an explicit flag.
      if (!target && !input.allowDuplicateTitle) {
        const existing = store.findByTitle(title, input.createdBy);
        if (existing) {
          throw new ServiceError(
            "TITLE_EXISTS",
            `An artifact titled "${title}" already exists (id ${existing.id}). To add a new ` +
              `version to it, upload again with artifactId ${existing.id}. To create a separate ` +
              "artifact, choose another title or set allowDuplicateTitle.",
            existing.id,
          );
        }
      }

      const filing = {
        ...(input.folderId === undefined ? {} : { folderId: input.folderId }),
        ...(input.tagIds === undefined ? {} : { tagIds: input.tagIds }),
      };
      const files = Object.keys(filing).length > 0;
      if (files) {
        if (!organization) {
          throw new ServiceError("INVALID_INPUT", "This server cannot file uploads.");
        }
        organization.checkAssignment(filing);
      }
      const file = (artifactId: string) => {
        if (files) {
          organization?.setArtifactOrganization(artifactId, {
            ...filing,
            actorId: input.createdBy,
          });
        }
      };

      if (target) {
        const artifact = await store.addVersion({
          artifactId: target.id,
          // A version upload without a description keeps the one it has.
          ...(description === null ? {} : { description }),
          originalFilename,
          content,
          ...(providedMarkdown === null ? {} : { providedMarkdown }),
          entrySchema,
          images,
          createdBy: input.createdBy,
          inApp: input.inApp,
        });
        if (!artifact) throw new ServiceError("NOT_FOUND", "No such artifact.");
        file(artifact.id);
        const current =
          visibility === undefined
            ? artifact
            : (store.setVisibility(artifact.id, visibility) ?? artifact);
        publish({ type: "artifact.changed", id: artifact.id });
        return { artifact: summary(current), newArtifact: false };
      }

      const artifact = await store.create({
        title,
        description,
        originalFilename,
        content,
        ...(providedMarkdown === null ? {} : { providedMarkdown }),
        entrySchema,
        images,
        visibility,
        createdBy: input.createdBy,
        inApp: input.inApp,
      });
      file(artifact.id);
      publish({ type: "artifact.created", id: artifact.id });
      return { artifact: summary(artifact), newArtifact: true };
    },

    versions(id, viewer) {
      visible(id, viewer);
      return store.versions(id).map(toVersionSummary);
    },

    setVisibility(id, visibility, actorId) {
      const checked = readVisibility(visibility);
      requireCreator(visible(id, { userId: actorId }), actorId);
      const artifact = store.setVisibility(id, checked);
      if (!artifact) throw new ServiceError("NOT_FOUND", "No such artifact.");
      publish({ type: "artifact.changed", id });
      return summary(artifact);
    },

    // Every admitted user who can see an artifact may move its status, archive
    // it, restore it, and comment on it. There are no roles here, so the record
    // of who did what is what matters, and every change carries the actor.
    setStatus(id, status, actorId, options) {
      visible(id, { userId: actorId });
      const artifact = store.setStatus(id, status, actorId, options);
      if (!artifact) throw new ServiceError("NOT_FOUND", "No such artifact.");
      publish({ type: "artifact.changed", id });
      return summary(artifact);
    },

    setArchived(id, archived, actorId, options) {
      visible(id, { userId: actorId });
      const artifact = store.setArchived(id, archived, actorId, options);
      if (!artifact) throw new ServiceError("NOT_FOUND", "No such artifact.");
      publish({ type: "artifact.changed", id });
      return summary(artifact);
    },

    comments(id, viewer) {
      visible(id, viewer);
      return commentStore.list(id);
    },

    addComment(id, input) {
      const artifact = visible(id, { userId: input.authorId });
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
        inApp: input.inApp,
      });
      publish({ type: "comment.changed", artifactId: id });
      return comment;
    },

    deleteComment(id, commentId, actorId) {
      visible(id, { userId: actorId });
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

    entries(id, viewer) {
      const artifact = visible(id, viewer);
      const schema = entryStore.schema(artifact.currentVersionId);
      return { entries: entryStore.list(id), schema: schema === null ? null : JSON.parse(schema) };
    },

    setEntry(id, input) {
      const artifact = writableKey(id, input.authorId, input.key);
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
      writableKey(id, input.authorId, input.key);
      limitWrites(id, input.authorId);
      if (entryStore.remove(id, input.authorId, input.key)) {
        publish({ type: "entry.changed", artifactId: id });
      }
    },

    async markdown(id, viewer, versionId) {
      const artifact = visible(id, viewer);
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

    async source(id, viewer, versionId) {
      const artifact = visible(id, viewer);
      const version = requireVersion(store, id, versionId ?? artifact.currentVersionId);
      const content = await readSource(store, version.id);
      return { artifact: summary(artifact), version: toVersionSummary(version), content };
    },

    async image(id, viewer, versionId, name) {
      visible(id, viewer);
      requireVersion(store, id, versionId);
      try {
        const result = await store.readVersionImage(versionId, name);
        if (!result) throw new ServiceError("NOT_FOUND", "No such image in this version.");
        return { contentType: result.image.contentType, content: result.content };
      } catch (cause) {
        if (cause instanceof ContentMissingError) {
          throw new ServiceError("CONTENT_MISSING", "This image is not available.");
        }
        throw cause;
      }
    },
  };
}

function parseVisibility(visibility: unknown): ArtifactVisibility {
  if (!VISIBILITIES.includes(visibility as ArtifactVisibility)) {
    throw new ServiceError("INVALID_INPUT", 'visibility is "shared" or "private".');
  }
  return visibility as ArtifactVisibility;
}

function requireCreator(artifact: Artifact, actorId: string) {
  if (artifact.createdBy !== actorId) {
    throw new ServiceError("FORBIDDEN", "Only the artifact's creator can change its visibility.");
  }
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
