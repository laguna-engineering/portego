import type { TeamStore } from "../storage/teams.ts";
import {
  EVERY_FOLDER,
  type FolderTree,
  type Reader,
  readableFolders,
  readsFolderIn,
  type Viewer,
} from "./reader.ts";

export type AccessService = {
  /** False when TEAMS is off: every folder is readable and nobody is a guest. */
  enabled: boolean;
  /** Read from the database on every call. Callers keep it for one request at most. */
  reader: (viewer: Viewer) => Reader;
  /**
   * Each account's reader for `folderIds` only, from one read of their paths
   * to the root. With teams on, it reads no other folder. Keep it for one
   * event at most: it does not see later changes.
   */
  readers: (folderIds: readonly string[]) => (userId: string) => Reader;
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
  const account = (userId: string | null) => {
    const guest = userId !== null && store.isGuest(userId);
    const teams = new Set(userId === null ? [] : store.teamIdsOf(userId));
    return { guest, teams };
  };

  return {
    enabled: true,
    reader(viewer) {
      if (viewer.linkHolder) return { userId: null, guest: false, ...EVERY_FOLDER };
      const { userId } = viewer;
      const { guest, teams } = account(userId);
      return {
        userId,
        guest,
        folders: readableFolders(store.folderTree(), teams, guest),
        unfiled: !guest,
      };
    },
    readers(folderIds) {
      const tree = store.folderPaths(folderIds);
      const built = new Map<string, Reader>();
      return (userId) => {
        let reader = built.get(userId);
        if (!reader) {
          const { guest, teams } = account(userId);
          const folders = new Set(folderIds.filter((id) => readsFolderIn(tree, teams, guest, id)));
          reader = { userId, guest, folders, unfiled: !guest };
          built.set(userId, reader);
        }
        return reader;
      };
    },
    tree: () => store.folderTree(),
  };
}
