import type { Folder } from "./api.ts";

/** The folder tree in display order: each folder is followed by its children. */
export function folderRows(folders: Folder[]): { folder: Folder; depth: number }[] {
  const children = new Map<string | null, Folder[]>();
  for (const folder of folders) {
    const siblings = children.get(folder.parentId) ?? [];
    siblings.push(folder);
    children.set(folder.parentId, siblings);
  }
  const rows: { folder: Folder; depth: number }[] = [];
  const visit = (parentId: string | null, depth: number) => {
    for (const folder of children.get(parentId) ?? []) {
      rows.push({ folder, depth });
      visit(folder.id, depth + 1);
    }
  };
  visit(null, 0);
  return rows;
}

/** Folder and tag names are unique regardless of case. */
export function sameName(a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;
}

/** A folder's name after its ancestors', e.g. "Lampo › Launch". */
export function folderPath(folder: Folder, folders: Folder[]): string {
  const byId = new Map(folders.map((other) => [other.id, other]));
  const names = [folder.name];
  let parent = folder.parentId ? byId.get(folder.parentId) : undefined;
  while (parent) {
    names.unshift(parent.name);
    parent = parent.parentId ? byId.get(parent.parentId) : undefined;
  }
  return names.join(" › ");
}

export type FolderRow = { folder: Folder; depth: number; hasChildren: boolean };

/** `folderRows` without the descendants of folders missing from `expanded`. */
export function visibleFolderRows(folders: Folder[], expanded: ReadonlySet<string>): FolderRow[] {
  const parents = new Set(folders.map((folder) => folder.parentId));
  const rows: FolderRow[] = [];
  let hiddenBelow = Number.POSITIVE_INFINITY;
  for (const { folder, depth } of folderRows(folders)) {
    if (depth > hiddenBelow) continue;
    hiddenBelow = Number.POSITIVE_INFINITY;
    const hasChildren = parents.has(folder.id);
    rows.push({ folder, depth, hasChildren });
    if (hasChildren && !expanded.has(folder.id)) hiddenBelow = depth;
  }
  return rows;
}

/** The ids of a folder's ancestors, nearest first. */
export function folderAncestors(id: string, folders: Folder[]): string[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const ids: string[] = [];
  let parentId = byId.get(id)?.parentId ?? null;
  while (parentId && !ids.includes(parentId)) {
    ids.push(parentId);
    parentId = byId.get(parentId)?.parentId ?? null;
  }
  return ids;
}
