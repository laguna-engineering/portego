import type { FolderScope, Reader } from "../access/reader.ts";

/**
 * Artifacts a reader can open: shared or their own, in a folder they can read.
 * Bind `readableBy(...)` where it appears.
 */
export const READABLE = `((artifacts.visibility = 'shared' or artifacts.createdBy = ?)
  and ((? and artifacts.folderId is not null)
    or artifacts.folderId in (select value from json_each(?))
    or (artifacts.folderId is null and ?)))`;

/** The parameters of `READABLE`. A null user reads shared artifacts only. */
export function readableBy(
  userId: string | null,
  scope: FolderScope,
): [string | null, number, string, number] {
  return [
    userId,
    scope.folders === null ? 1 : 0,
    JSON.stringify(scope.folders === null ? [] : [...scope.folders]),
    scope.unfiled ? 1 : 0,
  ];
}

/** Folders a scope can read, by the folder id in `column`. Bind `foldersReadableBy(...)`. */
export function readableFolder(column: string): string {
  return `(? or ${column} in (select value from json_each(?)))`;
}

export function foldersReadableBy(scope: FolderScope): [number, string] {
  return [
    scope.folders === null ? 1 : 0,
    JSON.stringify(scope.folders === null ? [] : [...scope.folders]),
  ];
}

/**
 * Tags a reader can see: every tag for a member, and for a guest only the tags
 * on artifacts the guest can read. Bind `tagSeenBy(...)` where it appears.
 */
export const TAG_SEEN = `(? or exists (select 1 from artifactTags
  join artifacts on artifacts.id = artifactTags.artifactId
  where artifactTags.tagId = tags.id and ${READABLE}))`;

export function tagSeenBy(reader: Reader): (string | number | null)[] {
  return [reader.guest ? 0 : 1, ...readableBy(reader.userId, reader)];
}
