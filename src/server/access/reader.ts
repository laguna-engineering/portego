import type { ArtifactVisibility } from "../storage/artifacts.ts";

/** Who asks to read. Services turn it into a `Reader`. */
export type Viewer = {
  /** Null for someone who is not signed in. */
  userId: string | null;
  /**
   * Set only after the caller checked the artifact's public link. A public
   * link works in every folder, so folders do not limit this viewer.
   */
  linkHolder?: true;
};

/** The folders someone can read. */
export type FolderScope = {
  /** Null when every folder is readable. */
  folders: ReadonlySet<string> | null;
  /** Whether artifacts in no folder are readable. */
  unfiled: boolean;
};

/** A viewer with the folders they can read, computed for one request. */
export type Reader = FolderScope & {
  userId: string | null;
  /** A guest reads only their teams' folders and sees nobody's email address. */
  guest: boolean;
};

export const EVERY_FOLDER: FolderScope = { folders: null, unfiled: true };

/** Reads nothing. For lookups that need a row, not its counts. */
export const NOBODY: Reader = { userId: null, guest: false, folders: new Set(), unfiled: false };

export type FolderTree = {
  parentOf: ReadonlyMap<string, string | null>;
  /** Only folders that have teams. */
  teamsOf: ReadonlyMap<string, ReadonlySet<string>>;
};

export function readsFolder(scope: FolderScope, folderId: string | null): boolean {
  if (folderId === null) return scope.unfiled;
  return scope.folders === null || scope.folders.has(folderId);
}

export function readsArtifact(
  reader: Reader,
  artifact: { visibility: ArtifactVisibility; createdBy: string; folderId: string | null },
): boolean {
  if (artifact.visibility === "private" && artifact.createdBy !== reader.userId) return false;
  return readsFolder(reader, artifact.folderId);
}

/** Folders from the root down to `folderId`. Empty for a folder that does not exist. */
export function pathTo(tree: FolderTree, folderId: string): string[] {
  const path: string[] = [];
  let current: string | null | undefined = folderId;
  while (current) {
    // A cycle would be a bug elsewhere. Reading nothing is the safe answer.
    if (!tree.parentOf.has(current) || path.includes(current)) return [];
    path.unshift(current);
    current = tree.parentOf.get(current);
  }
  return path;
}

/**
 * Every folder on the path must let the account in: for each one that has
 * teams, the account is in at least one of them. A guest also needs at least
 * one folder with teams on the path.
 */
export function readableFolders(
  tree: FolderTree,
  teams: ReadonlySet<string>,
  guest: boolean,
): Set<string> {
  const readable = new Set<string>();
  for (const folderId of tree.parentOf.keys()) {
    const path = pathTo(tree, folderId);
    let allowed = path.length > 0;
    let restricted = false;
    for (const id of path) {
      const required = tree.teamsOf.get(id);
      if (!required || required.size === 0) continue;
      restricted = true;
      if (![...required].some((team) => teams.has(team))) {
        allowed = false;
        break;
      }
    }
    if (allowed && (restricted || !guest)) readable.add(folderId);
  }
  return readable;
}

/**
 * The team sets on the path down to `folderId`, each as one key. Two places
 * with the same keys are open to the same accounts. Null is the root.
 */
export function restrictionsAt(tree: FolderTree, folderId: string | null): Set<string> {
  const keys = new Set<string>();
  if (folderId === null) return keys;
  for (const id of pathTo(tree, folderId)) {
    const teams = tree.teamsOf.get(id);
    if (teams && teams.size > 0) keys.add([...teams].sort().join(","));
  }
  return keys;
}
