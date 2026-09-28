# Storage

Artifact metadata lives in SQLite. The uploaded HTML and images live on disk.
All of it is under `DATA_DIR`, which production sets to `/var/lib/portego`.

```
<DATA_DIR>/app.db                          SQLite database, WAL mode
<DATA_DIR>/artifacts/ab/cd/...             uploaded HTML
<DATA_DIR>/images/<artifact-id>/<sha256>.* uploaded images, one folder per artifact
<DATA_DIR>/tmp/                            partial uploads, removed as soon as they land
```

Nothing under `DATA_DIR` is inside the static web root, and no static-file
middleware points at it. Uploaded HTML reaches a browser only through code that
decides what headers it gets.

## The artifacts table

| Column | Notes |
| --- | --- |
| `id` | UUIDv7. Opaque to clients, and ordered by creation time. |
| `title` | Required. |
| `description` | Optional. |
| `originalFilename` | The current version's, as the uploader typed it. Never used as a path. |
| `storageKey` | The current version's. Unique. |
| `sha256`, `byteSize` | Of the current version's stored bytes. |
| `createdBy` | References `user(id)`. |
| `createdAt`, `updatedAt` | Epoch milliseconds. |

Status, archive state, and comments are deliberately absent. They arrive in a
later migration.

## Artifact versions

Each version's bytes and digest are their own row, in a separate
`artifactVersions` table.

| Column | Notes |
| --- | --- |
| `id` | UUIDv7. |
| `artifactId` | References `artifacts(id)`. |
| `number` | 1-based. Unique together with `artifactId`. |
| `originalFilename` | Recorded as the uploader typed it. Never used as a path. |
| `storageKey` | Where this version's bytes are, under the same layout as `artifacts.storageKey`. One file per version. |
| `sha256`, `byteSize` | Of this version's stored bytes. |
| `createdBy` | References `user(id)`. |
| `createdAt` | Epoch milliseconds. |

Version 1 of every artifact that existed before versioning reuses the
artifact's own id and storage key, so the migration adds one row per
existing artifact without moving or renaming a single file.

The `artifacts` row mirrors its current version: `originalFilename`,
`storageKey`, `sha256`, and `byteSize` always hold the current version's
values, kept in sync when a new version is written.

The Markdown cache is keyed by version id rather than artifact id, so an
older version's converted Markdown survives a later upload. Comments carry
the id of the version they were written on.

## Images

An HTML upload can carry images that the page loads as `images/<name>`. Each
version has its own set in the `artifactImages` table, fixed when the version
is uploaded, so an older version keeps showing the images it had.

| Column | Notes |
| --- | --- |
| `versionId` | References `artifactVersions(id)`. Primary key together with `name`. |
| `name` | The name the HTML uses. 1 to 100 letters, digits, `.`, `-`, or `_`, starting with a letter or digit. Never used as a path. |
| `storageKey` | `<artifact-id>/<sha256>.<ext>`, relative to `images/`. |
| `sha256`, `byteSize` | Of the stored bytes. |
| `contentType` | Detected from the bytes at upload: PNG, JPEG, GIF, WebP, or AVIF. |

The file name is the hash of the bytes, so versions of one artifact that share
an image share one file, and an existing file is never written again. The
folder is named after the artifact the image was uploaded to. A merge moves
version rows and leaves image files where they are, because each row keeps its
`storageKey`.

Each image is at most 10 MiB. `ARTIFACT_MAX_IMAGES` (default 20) and
`ARTIFACT_IMAGES_MAX_BYTES` (default 50 MiB) limit one upload. One image that
fails a check refuses the whole upload.

## Folders and tags

`folders` stores the shared nested tree. `parentId` references another folder
and is null at the root. `artifacts.folderId` is nullable, so filing is
optional and each artifact has one location at most. `tags` stores the shared
tag catalog. `artifactTags` is the many-to-many assignment table, with one row
per artifact and tag pair.

Foreign keys remove assignments when a tag or artifact is removed. Folder
delete behavior is a service transaction: child folders are reparented and
direct artifacts are filed in the deleted folder's parent before the row is
removed. The database therefore cannot leave an artifact pointing to a deleted
folder.

## Writing an upload

1. The bytes go to `tmp/<random>.part`, which is written, flushed, and closed.
2. The temporary file is linked to `artifacts/<key>`, then unlinked from `tmp`.
3. The metadata row is inserted.

Each step depends on the previous one succeeding, which gives three
properties:

- **No partial artifact.** A name under `artifacts/` appears only when the file
  behind it is complete on disk.
- **No overwriting.** The final step is a link, which fails when the name is
  taken. Two uploads cannot land on the same file even if they somehow produced
  the same id.
- **No row without bytes.** The insert happens last, and its failure removes
  the file it would have pointed at.

The storage key comes from the artifact id: `<id[0:2]>/<id[2:4]>/<id>.html`. No
part of it comes from the uploaded filename, so an upload cannot choose where
its bytes land. Reading also refuses any key that does not have that exact
shape, so a tampered database row cannot reach a file elsewhere on the host.

Images are written the same way, before the metadata row, and their keys are
checked the same way. The final link of an image that is already stored fails
with the same bytes in place, which counts as success. When the row for a new
artifact cannot be written, its image folder is removed. When the row for a
new version cannot be written, its images stay, because another version may
share them. The reconciliation report lists any such file.

## Listing

The artifact listing stays global unless a folder or tag filter is supplied.
A folder filter matches direct assignments. Repeated tag filters require every
tag by default, or any selected tag with `tagMatch=any`. These conditions are
part of the same SQL query as pagination and ordering, so a cursor never
crosses into a different filtered result set.

Rows are ordered by a sort key and then by `id` in the same direction. The
default key is `updatedAt` descending; `createdAt` in either direction and
`title` in either direction (ignoring case) are also offered. The cursor carries the key
and id of the last row on a page, plus the sort it belongs to. Rows that share
a key therefore still have one fixed order, a page boundary cannot skip or
repeat a row, and a cursor cannot continue a listing under another sort.

## Migrations

`bun run migrate` applies the schema. It is safe to run on every release and
applies nothing when there is nothing new. The server never migrates on boot,
so a deployment cannot silently change the schema by restarting.

Better Auth owns `user`, `session`, `account`, and `verification`, and migrates
them first. Application migrations are an ordered list in
`src/server/storage/migrations.ts`; each runs in its own transaction and its id
is recorded in `schema_migrations`. Append new migrations. Editing one that has
already run does nothing on a database that recorded it.

Between the two runs `src/server/auth/schema-repair.ts`, for changes to Better
Auth's own tables that its migration does not make itself. It currently drops
`account.issuer`, a NOT NULL column Better Auth 1.7.0 through 1.7.2 created and
later versions do not write. A database that keeps the column refuses every
insert into `account`, which is every first sign-in. Each repair checks the
database first and does nothing when there is nothing to change.

## Merging two artifacts

Two artifacts that should have been versions of one, for example a document
uploaded twice before versions existed, can be folded together:

```sh
bun run merge-artifacts <into-id> <from-id>
```

Every version, comment, and entry of `from` moves under `into`. Where both
artifacts hold an entry from the same person for the same key, the newer value
stays. The merged entries can go past the entry limits, and writes that need
room are then refused until entries are cleared. Versions are renumbered by
upload time so the most recent upload becomes the current one, and the `from`
row is removed. The surviving artifact keeps its id, title, and
status, keeps its description unless it had none, and takes the earlier
creation time. Links to `from` stop working. Run it with the same environment
the service uses, and stop the service first so no upload lands in between.

## Reconciliation

`bun run reconcile` compares the metadata with the files and reports two kinds
of mismatch, checking every version's file, not just the current one:

- **missing file**: a row whose bytes are not on disk. That version, and the
  artifact itself when it is the current one, cannot be served.
- **orphaned file**: a file no row points at. It wastes space and serves
  nobody.

It makes the same two checks for image files, reported as **missing image**
and **orphaned image**.

The command deletes nothing and exits non-zero when it finds a mismatch, so a
deployment check can notice. Deciding what to do needs a person who knows
whether a restore is in progress.
