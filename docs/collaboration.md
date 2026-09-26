# Status, archiving, and comments

## Status and archiving are separate

An artifact has a status, `open` or `solved`, that says whether the question it
was shared for has an answer. Archiving is a separate pair of columns
(`archivedAt`, `archivedBy`). A solved artifact can also be archived, and
archiving one does not claim it was solved.

`open` is the status of every artifact that has no other, including every
artifact that existed before this feature: the column has a default and the
migration backfills nothing.

Archived artifacts are left out of the gallery unless `archived=true` is asked
for. A link to an archived artifact keeps working, so nothing anyone shared
ever breaks.

## Who may do what

Anyone the admission policy admits may change a status, archive, restore,
comment, and organize any artifact. They may also manage shared folders and
tags. There are no roles here, so the record of who did what
is what matters: every status change stores `statusChangedBy` and
`statusChangedAt`, archiving stores `archivedBy` and `archivedAt`, and a
comment stores its author and creation time.

## Comments

Comments are append-only rows. Two people commenting at the same moment write
two rows, so neither can overwrite the other and nothing has to be merged.

**A comment cannot be edited.** The text and the time it was written are the
record. The author may remove their own comment, and nobody else can; a removal
deletes the row. Someone who wants to correct a comment writes another one.

A comment can optionally carry an anchor that points at a passage of the
artifact's rendered text: `{ quote, prefix, suffix }`. `quote` is the selected
text (500 characters at most, and not empty); `prefix` and `suffix` are short
runs of text around it (100 characters at most each, and may be empty) that
tell repeated quotes apart. A comment with no anchor reads back with
`anchor: null`.

A comment can also carry `parentId`, the id of a root comment it replies to.
Threads are one level deep: a reply's `parentId` must name a root comment, not
another reply, and the client always replies to the comment that started the
thread. A reply cannot also carry an anchor — it belongs to the thread, not a
passage. Deleting a root deletes its replies with it, through the same
foreign key cascade the database already enforces elsewhere. `list` stays
flat and ordered by creation time; the client groups replies under their
root.

A comment also carries the id of the version of the artifact it was written
on. Without a `versionId`, a new comment attaches to the artifact's current
version; a `versionId` naming no version of the artifact is refused. A reply
is written on its parent's version regardless of any `versionId` given.
`list` reports each comment's `versionId` and `versionNumber`, so a reader
can tell which version a comment was about even after later versions arrive.

## Artifacts can read their comments

The artifact page sends the document its comments over the preview bridge,
when the document loads and whenever the list changes. Each carries `id`,
`body`, `author` (the name, never the email), `createdAt`, `anchor`,
`parentId`, and `versionNumber`. The document finds them on
`window.portego.comments` and hears of each update as a `portego:comments`
event on `window`. Anyone who can open the artifact can already read these
comments, and the document still cannot send anything out.

## Entries

Data a page or an agent records, such as votes and poll answers, goes in
entries rather than comments: one JSON value per person per key, which the
person can replace or remove. See [entries.md](entries.md).

## Everyone sees a change as it happens

A status change, an archive, an upload, a comment, an entry, and organization changes
announce themselves on `GET /api/events`, so a page that is already open shows
them without a reload. See [api.md](api.md) for the stream itself.

The announcement carries an id and nothing else. The client refetches through
the ordinary endpoints, so what a person is shown still comes from a route that
checked their session.

Two places treat the reader's own work as more important than being current.
An artifact page ignores an announcement while the reader's own change is in
flight, so a stale read cannot overwrite what they just did. A gallery the
reader has paged past the first page offers a refresh button rather than
rebuilding the list underneath them.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/artifacts?status=open\|solved&archived=true` | Filter the gallery |
| `PATCH` | `/api/artifacts/:id/status` | `{ "status": "open" \| "solved" }` |
| `PATCH` | `/api/artifacts/:id/archived` | `{ "archived": true \| false }` |
| `GET` | `/api/artifacts/:id/comments` | The thread, oldest first |
| `POST` | `/api/artifacts/:id/comments` | `{ "body": "…", "anchor"?: { "quote", "prefix", "suffix" }, "parentId"?: "…", "versionId"?: "…" }`, body 4000 characters at most |
| `DELETE` | `/api/artifacts/:id/comments/:commentId` | The author's own comment only |

Every route needs a session, and the actor comes from it.

## MCP

`list_artifacts` takes `status` and `includeArchived`. `set_artifact_status`
moves the status, archives, or restores. `list_artifact_comments` and
`add_artifact_comment` cover the thread, including replies through
`add_artifact_comment`'s optional `parentId`. The write tools need the
`artifacts:write` scope, and the actor is the token's subject, exactly as on the
web.

There is no MCP tool for removing a comment. Removal is a correction someone
makes to their own text, and it belongs where they wrote it.
