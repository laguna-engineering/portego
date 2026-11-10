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
  /** Empty when teams are off. */
  tree: () => FolderTree;
};

const EMPTY_TREE: FolderTree = { parentOf: new Map(), teamsOf: new Map() };

/** Access as it is with TEAMS unset. */
export const OPEN_ACCESS: AccessService = {
  enabled: false,
  reader: (viewer) => ({ userId: viewer.userId, guest: false, ...EVERY_FOLDER }),
  tree: () => EMPTY_TREE,
};

export function createAccessService(store: TeamStore): AccessService {
  return {
    enabled: true,
    reader(viewer) {
      if (viewer.linkHolder) return { userId: null, guest: false, ...EVERY_FOLDER };
      const { userId } = viewer;
      const guest = userId !== null && store.isGuest(userId);
      const teams = new Set(userId === null ? [] : store.teamIdsOf(userId));
      return {
        userId,
        guest,
        folders: readableFolders(store.folderTree(), teams, guest),
        unfiled: !guest,
      };
    },
    tree: () => store.folderTree(),
  };
}
