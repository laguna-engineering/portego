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
   * Readers that know only the folders on the paths from `folderIds` up to
   * the root, from one read of those paths. A null id adds no folder. With
   * teams on, they read no other folder, so they suit one artifact or one
   * folder, never a list or a search. Keep them for one request or event at
   * most: they do not see later changes.
   */
  readers: (folderIds: readonly (string | null)[]) => (viewer: Viewer) => Reader;
  /** Empty when teams are off. */
  tree: () => FolderTree;
};

const EMPTY_TREE: FolderTree = { parentOf: new Map(), teamsOf: new Map() };

const openReader = (viewer: Viewer): Reader => ({
  userId: viewer.userId,
  guest: false,
  ...EVERY_FOLDER,
});

/** Access as it is with TEAMS unset. */
export const OPEN_ACCESS: AccessService = {
  enabled: false,
  reader: openReader,
  readers: () => openReader,
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
      const tree = store.folderPaths(folderIds.filter((id): id is string => id !== null));
      const built = new Map<string | null, Reader>();
      return (viewer) => {
        if (viewer.linkHolder) return { userId: null, guest: false, ...EVERY_FOLDER };
        const { userId } = viewer;
        let reader = built.get(userId);
        if (!reader) {
          const { guest, teams } = account(userId);
          reader = { userId, guest, folders: readableFolders(tree, teams, guest), unfiled: !guest };
          built.set(userId, reader);
        }
        return reader;
      };
    },
    tree: () => store.folderTree(),
  };
}
