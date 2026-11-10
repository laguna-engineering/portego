import { NOBODY, type Reader, readsFolder, restrictionsAt } from "../access/reader.ts";
import { type AccessService, OPEN_ACCESS } from "../access/service.ts";
import { ServiceError } from "../artifacts/errors.ts";
import type { EventBus } from "../events/bus.ts";
import { ROOT_FOLDER_ID } from "../storage/artifacts.ts";
import type {
  ArtifactOrganization,
  Folder,
  OrganizationStore,
  Tag,
} from "../storage/organization.ts";

export const ORGANIZATION_NAME_MAX_LENGTH = 100;
export const MAX_ARTIFACT_TAGS = 20;

/**
 * Every method checks the folders and tags against what the actor or viewer
 * can read. A folder they cannot read does not exist for them.
 */
export type OrganizationService = {
  /**
   * The folders `viewerId` can read. Counts cover the artifacts they can see.
   * A folder whose parent they cannot read is listed at the top level.
   */
  folders: (viewerId: string) => Folder[];
  /** Artifacts `viewerId` can see that are filed in no folder, shown at the root of the tree. */
  rootArtifactCount: (viewerId: string) => number;
  createFolder: (input: { name: unknown; parentId?: unknown; actorId: string }) => Folder;
  /** `admin` allows a move that changes which teams restrict the folder. */
  updateFolder: (
    id: string,
    input: { name?: unknown; parentId?: unknown; actorId: string; admin?: boolean },
  ) => Folder;
  /** The actor is required when teams are on. */
  deleteFolder: (id: string, actorId?: string) => void;
  tags: (viewerId: string) => Tag[];
  createTag: (input: { name: unknown; actorId: string }) => Tag;
  updateTag: (id: string, input: { name: unknown; actorId: string }) => Tag;
  /** The actor is required when teams are on. */
  deleteTag: (id: string, actorId?: string) => void;
  assignments: (artifactIds: string[]) => Map<string, ArtifactOrganization>;
  /** The caller checks that the actor can read the artifact. */
  setArtifactOrganization: (
    artifactId: string,
    input: { folderId?: unknown; tagIds?: unknown; actorId: string },
  ) => void;
  /**
   * Refuses what setArtifactOrganization would refuse, without an artifact to
   * change. Returns the checked values.
   */
  checkAssignment: (
    input: { folderId?: unknown; tagIds?: unknown },
    actorId: string,
  ) => { folderId?: string | null; tagIds?: string[] };
  validateListFilters: (
    input: { folderId?: string | null; tagIds?: string[] },
    viewerId: string,
  ) => void;
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

function parentId(value: unknown, field = "parentId"): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value === "") {
    throw new ServiceError("INVALID_INPUT", `${field} must be a folder id or null.`);
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

function sameKeys(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((key) => b.has(key));
}

/**
 * Shared folders and tags. HTTP and MCP call this service. With teams on,
 * `access` limits each call to the folders the caller can read.
 */
export function createOrganizationService(options: {
  store: OrganizationStore;
  events?: EventBus;
  /** Proves that an artifact id exists before an assignment is changed. */
  artifactExists: (id: string) => boolean;
  /** Every folder is open to everyone when absent. */
  access?: AccessService;
}): OrganizationService {
  const { store } = options;
  const access = options.access ?? OPEN_ACCESS;
  const publish = options.events?.publish ?? (() => {});

  const readerOf = (userId: string): Reader => access.reader({ userId });
  // Without an actor nothing can be checked, which is only right with teams off.
  const optionalReader = (actorId: string | undefined): Reader | null => {
    if (actorId !== undefined) return readerOf(actorId);
    if (access.enabled) throw new Error("This change needs its actor when teams are on");
    return null;
  };

  const requireFolder = (id: string, reader: Reader): Folder => {
    const folder = store.getFolder(id, reader);
    if (!folder || !readsFolder(reader, id)) throw new ServiceError("NOT_FOUND", "No such folder.");
    return folder;
  };
  const requireTags = (ids: string[], reader: Reader): void => {
    if (store.getTags(ids, reader).length !== ids.length)
      throw new ServiceError("NOT_FOUND", "No such tag.");
  };
  const refuseGuest = (reader: Reader, message: string): void => {
    if (reader.guest) throw new ServiceError("FORBIDDEN", message);
  };
  const hasTeams = (folderId: string): boolean =>
    (access.tree().teamsOf.get(folderId)?.size ?? 0) > 0;
  // Walks parents the reader may not see, so it reads them without a reader.
  const wouldCycle = (folderId: string, candidateParentId: string | null): boolean => {
    let parentId = candidateParentId;
    while (parentId !== null) {
      if (parentId === folderId) return true;
      parentId = store.getFolder(parentId, NOBODY)?.parentId ?? null;
    }
    return false;
  };
  // A guest cannot read the folders above their teams' folders, so those
  // are not named as parents.
  const forReader = (folder: Folder, reader: Reader): Folder =>
    folder.parentId === null || readsFolder(reader, folder.parentId)
      ? folder
      : { ...folder, parentId: null };

  const checkAssignment = (input: { folderId?: unknown; tagIds?: unknown }, reader: Reader) => {
    const normalizedFolderId =
      input.folderId === undefined ? undefined : parentId(input.folderId, "folderId");
    const normalizedTagIds = input.tagIds === undefined ? undefined : tagIds(input.tagIds);
    if (normalizedFolderId === null && !reader.unfiled) {
      throw new ServiceError("FORBIDDEN", "A guest can only file artifacts in a team's folder.");
    }
    if (normalizedFolderId !== undefined && normalizedFolderId !== null)
      requireFolder(normalizedFolderId, reader);
    if (normalizedTagIds !== undefined) requireTags(normalizedTagIds, reader);
    return { normalizedFolderId, normalizedTagIds };
  };

  return {
    folders(viewerId) {
      const reader = readerOf(viewerId);
      return store
        .listFolders(reader)
        .filter((folder) => readsFolder(reader, folder.id))
        .map((folder) => forReader(folder, reader));
    },
    rootArtifactCount: (viewerId) => store.countUnfiled(readerOf(viewerId)),

    createFolder(input) {
      const reader = readerOf(input.actorId);
      const normalizedName = name(input.name);
      const normalizedParentId = input.parentId === undefined ? null : parentId(input.parentId);
      if (normalizedParentId === null) {
        refuseGuest(reader, "A guest can only create folders inside a team's folder.");
      } else {
        requireFolder(normalizedParentId, reader);
      }
      try {
        const folder = store.createFolder({
          name: normalizedName,
          parentId: normalizedParentId,
          actorId: input.actorId,
          reader,
        });
        publish({ type: "folder.changed", id: folder.id });
        return forReader(folder, reader);
      } catch (cause) {
        if (cause instanceof Error && /unique/i.test(cause.message)) {
          return conflict("A folder with that name already exists here.");
        }
        throw cause;
      }
    },

    updateFolder(id, input) {
      const reader = readerOf(input.actorId);
      const folder = requireFolder(id, reader);
      if (input.name === undefined && input.parentId === undefined) {
        throw new ServiceError("INVALID_INPUT", "Send a name, parentId, or both.");
      }
      if (hasTeams(id)) {
        refuseGuest(reader, "A guest cannot rename or move a folder that has teams.");
      }
      const normalizedName = input.name === undefined ? undefined : name(input.name);
      const normalizedParentId =
        input.parentId === undefined ? undefined : parentId(input.parentId);
      let revokeLinks = false;
      if (normalizedParentId !== undefined) {
        if (normalizedParentId !== null) requireFolder(normalizedParentId, reader);
        if (wouldCycle(folder.id, normalizedParentId)) {
          throw new ServiceError(
            "INVALID_INPUT",
            "A folder cannot contain itself or one of its children.",
          );
        }
        const tree = access.tree();
        const before = restrictionsAt(tree, folder.parentId);
        const after = restrictionsAt(tree, normalizedParentId);
        const changesTeams = !sameKeys(before, after);
        if ((changesTeams || hasTeams(id)) && !input.admin) {
          throw new ServiceError(
            "FORBIDDEN",
            "Only an administrator can move a folder that has teams, or move one into or out of a team's folder.",
          );
        }
        // Its public links were made for a wider audience than the new one.
        revokeLinks = changesTeams && [...after].some((key) => !before.has(key));
      }
      try {
        // A move can change who reads the folder. The stream checks each
        // reader when an event is sent, so announcing it before and after the
        // change reaches both the old readers and the new.
        if (normalizedParentId !== undefined) publish({ type: "folder.changed", id });
        const updated = store.updateFolder(id, {
          ...(normalizedName === undefined ? {} : { name: normalizedName }),
          ...(normalizedParentId === undefined ? {} : { parentId: normalizedParentId }),
          actorId: input.actorId,
          reader,
          revokeLinks,
        });
        if (!updated) throw new ServiceError("NOT_FOUND", "No such folder.");
        publish({ type: "folder.changed", id });
        for (const artifactId of updated.revoked)
          publish({ type: "artifact.changed", id: artifactId });
        return forReader(updated.folder, reader);
      } catch (cause) {
        if (cause instanceof Error && /unique/i.test(cause.message)) {
          return conflict("A folder with that name already exists here.");
        }
        throw cause;
      }
    },

    deleteFolder(id, actorId) {
      const reader = optionalReader(actorId);
      if (reader) requireFolder(id, reader);
      else if (!store.getFolder(id, NOBODY)) throw new ServiceError("NOT_FOUND", "No such folder.");
      if (reader && hasTeams(id)) {
        refuseGuest(reader, "A guest cannot delete a folder that has teams.");
        // Its contents would move to the parent, which more people can read.
        if (store.hasContent(id)) {
          throw new ServiceError(
            "FORBIDDEN",
            "A folder that has teams can only be deleted when it is empty.",
          );
        }
      }
      // Sent before the folder is gone, while the stream can still tell who
      // reads it.
      publish({ type: "folder.changed", id });
      const result = store.removeFolder(id);
      if (!result) throw new ServiceError("NOT_FOUND", "No such folder.");
      for (const artifactId of result.artifactIds)
        publish({ type: "artifact.changed", id: artifactId });
    },

    tags: (viewerId) => store.listTags(readerOf(viewerId)),

    createTag(input) {
      const reader = readerOf(input.actorId);
      refuseGuest(reader, "A guest cannot create tags.");
      try {
        const tag = store.createTag({ name: name(input.name), actorId: input.actorId, reader });
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
      const reader = readerOf(input.actorId);
      refuseGuest(reader, "A guest cannot change tags.");
      try {
        const tag = store.updateTag(id, { name: name(input.name), actorId: input.actorId, reader });
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

    deleteTag(id, actorId) {
      const reader = optionalReader(actorId);
      if (reader) refuseGuest(reader, "A guest cannot delete tags.");
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
      const { normalizedFolderId, normalizedTagIds } = checkAssignment(
        input,
        readerOf(input.actorId),
      );
      // A move between folders can change who reads the artifact; see updateFolder.
      if (access.enabled && normalizedFolderId !== undefined) {
        publish({ type: "artifact.changed", id: artifactId });
      }
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

    checkAssignment(input, actorId) {
      const { normalizedFolderId, normalizedTagIds } = checkAssignment(input, readerOf(actorId));
      return {
        ...(normalizedFolderId === undefined ? {} : { folderId: normalizedFolderId }),
        ...(normalizedTagIds === undefined ? {} : { tagIds: normalizedTagIds }),
      };
    },

    validateListFilters(input, viewerId) {
      const reader = readerOf(viewerId);
      if (input.folderId && input.folderId !== ROOT_FOLDER_ID)
        requireFolder(input.folderId, reader);
      if (input.tagIds) requireTags(tagIds(input.tagIds), reader);
    },
  };
}
