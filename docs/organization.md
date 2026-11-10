# Folders and tags

Folders and tags organize shared artifacts. Without teams they do not limit
access: every user admitted to the application can read and change them. With
`TEAMS=true`, an admin can restrict a folder to teams, as [Teams](#teams)
describes. The artifact listing remains the global view: omit `folderId` and
`tagId` from `GET /api/artifacts` to list every artifact the reader can see
that matches the normal search, status, archive, and sort filters.

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

## Teams

`TEAMS=true` lets admins restrict folders to teams and invite guests. It needs
`PORTEGO_ADMINS`, and the server does not start without it. With the setting
unset, every folder is open to every member, nobody is a guest, and the
routes under `/api/teams` and `/api/invitations` do not exist.

A team has a name and members. An admin assigns teams to folders, and a
folder may have several teams. Only admins manage teams, folder restrictions,
and invitations, in the web client's settings or over the API. No MCP tool
does: an agent never manages access.

### Who reads a folder

There are two kinds of account:

- A member is admitted by the email-domain policy. A member reads every folder
  with no team on its path, and the folders of their teams.
- A guest is a person an admin invited from any domain, or a service account
  an admin approved as a guest. A guest reads only the folders of their teams,
  and no artifact outside a folder.

To read a folder, an account must pass every folder on the path from the top
down to it: for each folder that has teams, the account is in at least one of
them. A team on a subfolder therefore narrows access and never widens it. A
guest also needs at least one folder with teams on the path.

An artifact in a folder the account cannot read does not exist for that
account. Every route that names it answers `NOT_FOUND`, and lists, search,
folder and tag counts, the activity feed, profiles, and the change stream
leave it out. A private artifact stays visible to its creator only, in any
folder.

Admins do not bypass teams. An admin who needs to read a restricted folder
adds themselves to its team, and the membership records who added it.

### What a guest can do

A guest:

- sees only the folders they can read. A folder whose parent they cannot read
  is listed at the top level.
- sees only the tags on artifacts they can read, and cannot create, rename, or
  delete a tag.
- cannot create a top-level folder, and cannot rename, move, or delete a
  folder that has teams.
- names a folder for every new upload, and cannot move an artifact out of
  their folders.
- gets `null` for every email address: an artifact's creator, a version's
  uploader, and the author of a comment or an entry.
- sees another person's profile only when that person uploaded to, commented
  on, or set an entry on an artifact the guest can read.
- cannot make or revoke a public link, and cannot make an artifact private or
  shared again.

### Changing restricted folders

- Creating, renaming, or moving a folder needs read access to the folder and
  to its new parent.
- Moving a folder that has teams, or a move that changes the teams on a
  folder's path, is for admins only.
- Deleting a folder that has teams is refused while it holds artifacts or
  folders. Otherwise they would move to its parent, which more people can read.
- Filing an artifact in a folder needs read access to that folder. A team
  member can move an artifact out of a restricted folder.
- A team that restricts a folder cannot be deleted. Remove it from its folders
  first, so no folder loses a restriction by accident.

### Public links

Any member who can read an artifact can make or revoke its public link, also
in a restricted folder. A public link opens its artifact whatever folder it
is in.

When a folder gets its first team, or an admin's move puts it under a folder
with a team, the links of the artifacts in it and below it are revoked in the
same change. Each revocation shows in the creator's activity feed, as a
revocation by a person does. A second team on a folder widens who can read it
and revokes nothing. An artifact with a link that a team member moves into a
restricted folder keeps its link.

### Invitations

An admin invites an email address into one or more teams. An invitation
expires after 7 days, and an admin can revoke it until it is used. The person
signs in with that address through Google or OpenID Connect, which must
report it verified, and is admitted although its domain is not allowed. Their
first session makes them a guest in the invited teams and uses the
invitation up. From then on they are admitted as a guest.

A person whose domain is allowed stays a member when invited, and the
invitation only adds the teams. An address at `service.invalid` cannot be
invited.

### Service accounts

With teams on, the approval page offers member or guest for a new service
account, and the teams of a guest. A guest service account reads only its
teams' folders, so the folders it needs must carry its team, which hides them
from members outside that team. An agent that works on pages in open
folders, a review runner for example, should be a member. A re-enrolled
account keeps its kind.

### Turning teams off

Unsetting `TEAMS` opens every folder to every member. Invited guests are
refused at their next sign-in and on every MCP request, because their domain
is not allowed. A guest service account keeps working, as a member, since
nobody is a guest with teams off. An invited guest's browser session that
already exists keeps working until it expires, now with a member's access. To
end those sessions before turning teams off, delete them:

```sql
delete from session where userId in (select userId from guests);
```

Turning teams on again restores every team, restriction, and guest.

### Known limitations

- Folder names are unique among siblings, including siblings the account
  cannot read. Creating or renaming a folder can therefore reveal that a
  hidden sibling has that name.
- Removing one of several teams from a folder narrows who can read it, and
  revokes no link.
- A revoked link shows in the creator's feed only while the creator can read
  the artifact.
