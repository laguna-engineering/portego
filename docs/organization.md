# Folders and tags

Folders and tags organize shared artifacts. They do not limit access. Every user
admitted to the application can read and change them. The existing artifact
listing remains the global view: omit `folderId` and `tagId` from
`GET /api/artifacts` to list every artifact that matches the normal search,
status, archive, and sort filters.

## Model

An artifact has zero or one folder. A folder can have one parent, which makes a
shared tree. An artifact may have up to 20 shared tags. Tags are many-to-many:
a tag can apply to many artifacts and an artifact can have many tags.

Folder names are unique among siblings without regard to case. Tag names are
global and unique without regard to case. API clients use opaque ids, never
names, for assignment and filtering.

The API returns an artifact's current organization as:

```json
{
  "folder": { "id": "…", "name": "Research", "parentId": null },
  "tags": [{ "id": "…", "name": "Urgent" }]
}
```

`folder` is `null` when the artifact is unfiled. `tags` is an empty array when
it has no tags.

## Changes

Deleting a tag removes its assignments and preserves every artifact. Deleting
a folder reparents its child folders and moves artifacts filed directly in it
to its parent. Deleting a root folder leaves those artifacts unfiled.

Folder and tag rows record their creator and most recent editor. Assignments
record who applied tags. An organization change updates the artifact timestamp,
so the normal `updated-desc` global listing includes it.

## Future permissions

The storage layer has no user-specific organization fields and no permission
tables. The current policy is deliberately at the service boundary:
`OrganizationService` and `ArtifactService` are shared by HTTP and MCP, while
the routes provide the authenticated actor. A workspace and membership policy
can be added later by scoping folders, tags, assignments, and artifacts to a
workspace, then checking the same service calls. IDs and assignment relations
stay stable, so API clients do not need to use folder paths or tag names as
permissions.
