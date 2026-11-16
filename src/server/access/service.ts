import type { TeamStore } from "../storage/teams.ts";
import {
  EVERY_FOLDER,
  type FolderTree,
  type Reader,
  readableFolders,
  type Viewer,
} from "./reader.ts";

export type AccessService = {
  /** False when TEAMS is off: every folder is readable and nobody is a guest. */
  enabled: boolean;
  /** Read from the database on every call. Callers keep it for one request at most. */
  reader: (viewer: Viewer) => Reader;
  /**
   * Each account's reader, from one read of the folder tree. Keep it for one
   * event at most: it does not see later changes.
   */
  readers: () => (userId: string) => Reader;
  /** Empty when teams are off. */
  tree: () => FolderTree;
};

const EMPTY_TREE: FolderTree = { parentOf: new Map(), teamsOf: new Map() };

/** Access as it is with TEAMS unset. */
export const OPEN_ACCESS: AccessService = {
  enabled: false,
  reader: (viewer) => ({ userId: viewer.userId, guest: false, ...EVERY_FOLDER }),
  readers: () => (userId) => ({ userId, guest: false, ...EVERY_FOLDER }),
  tree: () => EMPTY_TREE,
};

export function createAccessService(store: TeamStore): AccessService {
  const readerIn = (tree: FolderTree, viewer: Viewer): Reader => {
    if (viewer.linkHolder) return { userId: null, guest: false, ...EVERY_FOLDER };
    const { userId } = viewer;
    const guest = userId !== null && store.isGuest(userId);
    const teams = new Set(userId === null ? [] : store.teamIdsOf(userId));
    return { userId, guest, folders: readableFolders(tree, teams, guest), unfiled: !guest };
  };

  return {
    enabled: true,
    reader: (viewer) => readerIn(store.folderTree(), viewer),
    readers() {
      const tree = store.folderTree();
      const built = new Map<string, Reader>();
      return (userId) => {
        let reader = built.get(userId);
        if (!reader) {
          reader = readerIn(tree, { userId });
          built.set(userId, reader);
        }
        return reader;
      };
    },
    tree: () => store.folderTree(),
  };
}
