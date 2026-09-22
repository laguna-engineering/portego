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
