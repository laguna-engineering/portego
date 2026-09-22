import { ServiceError } from "../artifacts/errors.ts";
import type { EventBus } from "../events/bus.ts";
import type {
  ArtifactOrganization,
  Folder,
  OrganizationStore,
  Tag,
} from "../storage/organization.ts";

export const ORGANIZATION_NAME_MAX_LENGTH = 100;
export const MAX_ARTIFACT_TAGS = 20;

export type OrganizationService = {
  folders: () => Folder[];
  createFolder: (input: { name: unknown; parentId?: unknown; actorId: string }) => Folder;
  updateFolder: (
    id: string,
    input: { name?: unknown; parentId?: unknown; actorId: string },
  ) => Folder;
  deleteFolder: (id: string) => void;
  tags: () => Tag[];
  createTag: (input: { name: unknown; actorId: string }) => Tag;
  updateTag: (id: string, input: { name: unknown; actorId: string }) => Tag;
  deleteTag: (id: string) => void;
  assignments: (artifactIds: string[]) => Map<string, ArtifactOrganization>;
  setArtifactOrganization: (
    artifactId: string,
    input: { folderId?: unknown; tagIds?: unknown; actorId: string },
  ) => void;
  validateListFilters: (input: { folderId?: string | null; tagIds?: string[] }) => void;
};

function name(value: unknown, field = "name"): string {
  if (typeof value !== "string")
    throw new ServiceError("INVALID_INPUT", `${field} must be a string.`);
  const normalized = value.trim();
  if (normalized === "") throw new ServiceError("INVALID_INPUT", `${field} cannot be empty.`);
  if (normalized.length > ORGANIZATION_NAME_MAX_LENGTH) {
    throw new ServiceError(
      "INVALID_INPUT",
      `${field} is at most ${ORGANIZATION_NAME_MAX_LENGTH} characters.`,
    );
  }
  return normalized;
}

function parentId(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value === "") {
    throw new ServiceError("INVALID_INPUT", "parentId must be a folder id or null.");
  }
  return value;
}

function tagIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || id === "")) {
    throw new ServiceError("INVALID_INPUT", "tagIds must be an array of tag ids.");
  }
  if (value.length > MAX_ARTIFACT_TAGS) {
    throw new ServiceError("INVALID_INPUT", `An artifact has at most ${MAX_ARTIFACT_TAGS} tags.`);
  }
  if (new Set(value).size !== value.length) {
    throw new ServiceError("INVALID_INPUT", "tagIds cannot contain the same tag more than once.");
  }
  return value;
}

function conflict(message: string): never {
  throw new ServiceError("INVALID_INPUT", message);
}

/**
 * Shared folders and tags. HTTP and MCP call this service, which keeps the
 * current all-admitted-users policy outside the store and ready to replace
 * with scope checks when the application gains permissions.
 */
export function createOrganizationService(options: {
  store: OrganizationStore;
  events?: EventBus;
  /** Proves that an artifact id exists before an assignment is changed. */
  artifactExists: (id: string) => boolean;
}): OrganizationService {
  const { store } = options;
  const publish = options.events?.publish ?? (() => {});

  const requireFolder = (id: string): Folder => {
    const folder = store.getFolder(id);
    if (!folder) throw new ServiceError("NOT_FOUND", "No such folder.");
    return folder;
  };
  const requireTags = (ids: string[]): void => {
    if (store.getTags(ids).length !== ids.length)
      throw new ServiceError("NOT_FOUND", "No such tag.");
  };
  const wouldCycle = (folderId: string, candidateParentId: string | null): boolean => {
    let parentId = candidateParentId;
    while (parentId !== null) {
      if (parentId === folderId) return true;
      parentId = requireFolder(parentId).parentId;
    }
    return false;
  };

  return {
    folders: () => store.listFolders(),

    createFolder(input) {
      const normalizedName = name(input.name);
      const normalizedParentId = input.parentId === undefined ? null : parentId(input.parentId);
      if (normalizedParentId !== null) requireFolder(normalizedParentId);
      try {
        const folder = store.createFolder({
          name: normalizedName,
          parentId: normalizedParentId,
          actorId: input.actorId,
        });
        publish({ type: "folder.changed", id: folder.id });
        return folder;
      } catch (cause) {
        if (cause instanceof Error && /unique/i.test(cause.message)) {
          return conflict("A folder with that name already exists here.");
        }
        throw cause;
      }
    },

    updateFolder(id, input) {
      const folder = requireFolder(id);
      if (input.name === undefined && input.parentId === undefined) {
        throw new ServiceError("INVALID_INPUT", "Send a name, parentId, or both.");
      }
      const normalizedName = input.name === undefined ? undefined : name(input.name);
      const normalizedParentId =
        input.parentId === undefined ? undefined : parentId(input.parentId);
      if (normalizedParentId !== undefined) {
        if (normalizedParentId !== null) requireFolder(normalizedParentId);
        if (wouldCycle(folder.id, normalizedParentId)) {
          throw new ServiceError(
            "INVALID_INPUT",
            "A folder cannot contain itself or one of its children.",
          );
        }
      }
      try {
        const updated = store.updateFolder(id, {
          ...(normalizedName === undefined ? {} : { name: normalizedName }),
          ...(normalizedParentId === undefined ? {} : { parentId: normalizedParentId }),
          actorId: input.actorId,
        });
        if (!updated) throw new ServiceError("NOT_FOUND", "No such folder.");
        publish({ type: "folder.changed", id });
        return updated;
      } catch (cause) {
        if (cause instanceof Error && /unique/i.test(cause.message)) {
          return conflict("A folder with that name already exists here.");
        }
        throw cause;
      }
    },

    deleteFolder(id) {
      const result = store.removeFolder(id);
      if (!result) throw new ServiceError("NOT_FOUND", "No such folder.");
      publish({ type: "folder.changed", id });
      for (const artifactId of result.artifactIds)
        publish({ type: "artifact.changed", id: artifactId });
    },

    tags: () => store.listTags(),

    createTag(input) {
      try {
        const tag = store.createTag({ name: name(input.name), actorId: input.actorId });
        publish({ type: "tag.changed", id: tag.id });
        return tag;
      } catch (cause) {
        if (cause instanceof Error && /unique/i.test(cause.message)) {
          return conflict("A tag with that name already exists.");
        }
        throw cause;
      }
    },

    updateTag(id, input) {
      try {
        const tag = store.updateTag(id, { name: name(input.name), actorId: input.actorId });
        if (!tag) throw new ServiceError("NOT_FOUND", "No such tag.");
        publish({ type: "tag.changed", id });
        return tag;
      } catch (cause) {
        if (cause instanceof Error && /unique/i.test(cause.message)) {
          return conflict("A tag with that name already exists.");
        }
        throw cause;
      }
    },

    deleteTag(id) {
      const result = store.removeTag(id);
      if (!result) throw new ServiceError("NOT_FOUND", "No such tag.");
      publish({ type: "tag.changed", id });
      for (const artifactId of result.artifactIds)
        publish({ type: "artifact.changed", id: artifactId });
    },

    assignments: (artifactIds) => store.assignments(artifactIds),

    setArtifactOrganization(artifactId, input) {
      if (!options.artifactExists(artifactId)) {
        throw new ServiceError("NOT_FOUND", "No such artifact.");
      }
      if (input.folderId === undefined && input.tagIds === undefined) {
        throw new ServiceError("INVALID_INPUT", "Send folderId, tagIds, or both.");
      }
      const normalizedFolderId =
        input.folderId === undefined ? undefined : parentId(input.folderId);
      const normalizedTagIds = input.tagIds === undefined ? undefined : tagIds(input.tagIds);
      if (normalizedFolderId !== undefined && normalizedFolderId !== null)
        requireFolder(normalizedFolderId);
      if (normalizedTagIds !== undefined) requireTags(normalizedTagIds);
      if (
        store.setArtifactOrganization({
          artifactId,
          ...(normalizedFolderId === undefined ? {} : { folderId: normalizedFolderId }),
          ...(normalizedTagIds === undefined ? {} : { tagIds: normalizedTagIds }),
          actorId: input.actorId,
        })
      ) {
        publish({ type: "artifact.changed", id: artifactId });
      }
    },

    validateListFilters(input) {
      if (input.folderId) requireFolder(input.folderId);
      if (input.tagIds) requireTags(tagIds(input.tagIds));
    },
  };
}
