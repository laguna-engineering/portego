# Artifact API

Every route under `/api/artifacts` needs a session. Requests without one
receive 401 before any lookup, so an anonymous request cannot learn whether
an artifact id exists. `POST /api/uploads` is the exception: it takes a signed
upload ticket, which is how an MCP client sends a file rather than putting the
document in a tool argument.

The rules live in a transport-independent service
(`src/server/artifacts/service.ts`). The HTTP routes are one caller. The MCP
tools are another, and they call the same methods rather than making HTTP
requests to this application.

`GET /api/me` returns the signed-in user and the limits the client needs to
check an upload before sending it.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/artifacts` | List, most recently updated first |
| `POST` | `/api/artifacts` | Upload one HTML document, or a new version of one |
| `GET` | `/api/artifacts/:id` | Metadata for one artifact |
| `GET` | `/api/artifacts/:id/versions` | List an artifact's versions, highest number first |
| `PATCH` | `/api/artifacts/:id/status` | Mark open or solved |
| `PATCH` | `/api/artifacts/:id/archived` | Archive or restore |
| `PATCH` | `/api/artifacts/:id/organization` | Set its folder or tags |
| `GET` | `/api/folders` | List the shared folder tree |
| `POST` | `/api/folders` | Create a shared folder |
| `PATCH` | `/api/folders/:id` | Rename or move a folder |
| `DELETE` | `/api/folders/:id` | Delete a folder and preserve its contents |
| `GET` | `/api/tags` | List shared tags |
| `POST` | `/api/tags` | Create a shared tag |
| `PATCH` | `/api/tags/:id` | Rename a tag |
| `DELETE` | `/api/tags/:id` | Delete a tag and preserve artifacts |
| `GET` | `/api/artifacts/:id/comments` | The comment thread, across every version |
| `POST` | `/api/artifacts/:id/comments` | Add a comment, optionally anchored to a passage of text, on a version, or replying to a root comment |
| `DELETE` | `/api/artifacts/:id/comments/:commentId` | Remove your own comment |
| `GET` | `/api/artifacts/:id/entries` | Every entry on the artifact, and the current version's entry schema |
| `PUT` | `/api/artifacts/:id/entries` | Set your value for one key |
| `DELETE` | `/api/artifacts/:id/entries?key=…` | Remove your value for one key |
| `GET` | `/api/artifacts/:id/markdown` | The static content as Markdown, for one version |
| `GET` | `/api/artifacts/:id/source` | Download the stored bytes of one version |
| `POST` | `/api/artifacts/:id/preview` | Mint a short-lived preview URL for one version |
| `POST` | `/api/uploads` | Upload one HTML document with a ticket, no session, or a new version of one |
| `GET` | `/api/events` | Subscribe to changes, as Server-Sent Events |

### List

Query parameters: `q` filters on title and description, `status` is `open` or
`solved`, `archived=true` includes archived artifacts (they are left out
otherwise), `folderId` filters to artifacts filed directly in one folder, and
repeated `tagId` filters by tags. Tag filters require every selected tag by
default; `tagMatch=any` matches any selected tag. `sort` picks the order,
`cursor` continues a page, and `limit` sets the page size (24 by default, 100
at most).

Omit `folderId` and `tagId` for the global listing. This is the default view and
always includes artifacts regardless of their folder or tags.

`sort` is one of `updated-desc` (the default), `updated-asc`, `created-desc`,
`created-asc`, `title-asc`, or `title-desc`. Title order ignores case.

```json
{ "items": [{ "id": "…", "title": "…" }], "nextCursor": "eyJ…" }
```

Rows are ordered by the sort key and then by id, and the cursor carries both
along with the sort that produced it. Rows that share a key still have one fixed
order, so a page boundary cannot skip or repeat a row. A cursor this application
did not produce, or one issued under a different `sort`, is refused with
`INVALID_CURSOR`.

### Change stream

`GET /api/events` holds a Server-Sent Events stream open and announces what
changed. It needs a session, like every other route here.

```
retry: 3000

data: {"type":"artifact.created","id":"01J…"}

: keep-alive
```

Six event types are sent: `artifact.created`, `artifact.changed`,
`folder.changed`, and `tag.changed` carry `id`; `comment.changed` and
`entry.changed` carry `artifactId`.

An event names what changed and carries nothing else. A client reads the new
state through the ordinary endpoints above, so every answer stays subject to
the checks that route already makes, and the stream itself never holds a body
one recipient may read and another may not.

The comment line every 20 seconds is what keeps an idle connection alive
through a proxy, and it is how the server learns that a client has gone. See
[deployment.md](deployment.md) for what the proxy needs.

A client that reconnects is not sent what it missed. There is no event log to
replay from. `EventSource` reconnects by itself, and the client refetches what
it is displaying when the connection returns, which covers the same gap
without keeping a log.

The stream is refused with 503 `TOO_MANY_STREAMS` above 8 connections for one
user or 200 in total.

### Upload

`multipart/form-data` with a `file` part and optional `title`,
`description`, and `artifactId` parts.

- The creator is taken from the session and reported as
  `creator: { id, name, email }`. A `createdBy` field in the form is ignored.
- The MIME type and the filename are hints. The document itself has to be
  valid UTF-8 and has to look like HTML.
- 5 MiB at most, configurable with `ARTIFACT_MAX_BYTES`. The server also
  refuses a larger request body before reading it.
- The title comes from the form. Without one, it comes from the document's
  `<title>`. With neither, the upload is refused: no title is invented.
- A title over 200 characters or a description over 2000 is refused. A title
  taken from the document is truncated instead, because the uploader did not
  write it.
- The filename is reduced to its last segment and recorded for the download.
  No part of any stored path comes from it.
- `artifactId` names an existing artifact to add this upload to as a new
  version, instead of creating one. Without it, a title matching a
  non-archived artifact's title (after trimming) does the same, choosing the
  most recently updated match. An `artifactId` naming no artifact is refused
  with `NOT_FOUND`. A version upload replaces the artifact's description
  when one is given and keeps it otherwise; the title never changes.

The response is `201 { artifact, newArtifact }`: `artifact` is the metadata
and `newArtifact` is `false` when the upload added a version to an existing
artifact instead of creating one. The storage key is never included.

### Upload with a ticket

`POST /api/uploads` takes the same multipart body and applies the same rules.
It reads no cookie. The ticket travels in the `Authorization` header:

```
Authorization: Bearer <ticket>
```

The creator is the user the ticket names. A ticket that is malformed, forged,
or expired is refused with `UNAUTHENTICATED`, and the reason stays on the
server. `create_upload_ticket` on the MCP endpoint issues them; see
[docs/mcp.md](mcp.md).

### Versions

`GET /api/artifacts/:id/versions` returns `{ versions: ArtifactVersion[] }`,
highest version number first:

```json
{
  "id": "…",
  "number": 1,
  "originalFilename": "chart.html",
  "sha256": "…",
  "byteSize": 12345,
  "creator": { "id": "…", "name": "…", "email": "…" },
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

`GET /api/artifacts/:id/source`, `GET /api/artifacts/:id/markdown`, and
`POST /api/artifacts/:id/preview` each take an optional `version` query
parameter naming a version id. Without one, each acts on the artifact's
current version. A version id that does not belong to the artifact is
refused with `NOT_FOUND`. The source download's `Content-Disposition` names
that version's original filename. `POST /api/artifacts/:id/preview` still
responds `{ url, expiresAt }`; the URL serves that version's bytes.

### Organization

`GET /api/folders` returns the shared folders as a flat array. Each record has
`id`, `name`, `parentId`, timestamps, and `artifactCount` for artifacts filed
directly in that folder. `POST /api/folders` accepts `{ "name", "parentId"? }`;
omit `parentId` for a root folder. `PATCH /api/folders/:id` accepts either or
both fields, with `parentId: null` moving a folder to the root. A folder cannot
be its own parent or descendant. Deleting one reparents its children and moves
its direct artifacts to its parent, or unfiles them when it was a root.

`GET /api/tags` returns the shared tags with `id`, `name`, timestamps, and
`artifactCount`. `POST /api/tags` accepts `{ "name" }`; `PATCH /api/tags/:id`
accepts the same. Deleting a tag removes its assignments and preserves its
artifacts.

`PATCH /api/artifacts/:id/organization` accepts either or both of:

```json
{ "folderId": "…", "tagIds": ["…", "…"] }
```

Omit a field to keep it. Set `folderId` to `null` to unfile the artifact. Set
`tagIds` to `[]` to remove every tag. `tagIds` replaces the complete set, must
not repeat an id, and has a limit of 20. Folder and tag names are at most 100
characters and are unique without regard to case (folder names only among the
same siblings).

### Comments

`POST /api/artifacts/:id/comments` accepts an optional `versionId` in its
JSON body, defaulting to the artifact's current version. A version id that
does not belong to the artifact is refused with `NOT_FOUND`. A reply
(`parentId` set) is written on its parent's version; a `versionId` given on a
reply is ignored. `GET /api/artifacts/:id/comments` returns every comment
across every version, each carrying `versionId` and `versionNumber`.

### Entries

See [entries.md](entries.md) for the contract, the page API, and the entry
schema. A write that does not fit the current version's schema is refused
with `INVALID_INPUT` and a message naming the problem. An upload whose
`portego-entries` schema is broken is refused the same way.

### Source download

The response carries the stored bytes with:

```
Content-Type: application/octet-stream
Content-Disposition: attachment; filename="chart.html"; filename*=UTF-8''chart.html
X-Content-Type-Options: nosniff
Cache-Control: private, no-store
```

The bytes are untrusted HTML, so this origin never offers them as a document
to render. The isolated content host does that, over a short-lived preview URL
that #6 adds.

## Errors

Every failure has the same shape:

```json
{ "error": { "code": "NOT_FOUND", "message": "No such artifact." } }
```

| Code | Status | Meaning |
| --- | --- | --- |
| `UNAUTHENTICATED` | 401 | No session, or no usable upload ticket. |
| `NOT_FOUND` | 404 | No artifact with that id. |
| `FORBIDDEN` | 403 | The action is not this caller's to take. |
| `INVALID_INPUT` | 400 | A field is missing, malformed, or too long. |
| `TITLE_REQUIRED` | 400 | No title given and none in the document. |
| `UNSUPPORTED_CONTENT` | 400 | Not valid UTF-8, or not an HTML document. |
| `FILE_TOO_LARGE` | 413 | Over `ARTIFACT_MAX_BYTES`. |
| `INVALID_CURSOR` | 400 | The pagination cursor is not one we issued. |
| `RATE_LIMITED` | 429 | Too many entry changes in the last minute. |
| `CONTENT_MISSING` | 500 | The metadata exists but its bytes do not. |
| `INTERNAL` | 500 | An unexpected failure. Nothing the caller can fix. |

The codes are part of the contract shared with the MCP tools. Add a code
rather than changing what an existing one means.
