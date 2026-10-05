import type { Database } from "bun:sqlite";

export type Migration = { id: string; sql: string };

/**
 * Ordered application migrations. Deployment applies them explicitly; the
 * server never migrates on boot. Append new entries, never edit an applied
 * one: the id is what records that a migration already ran.
 *
 * Better Auth owns the user, session, account, and verification tables and
 * migrates them separately. These run after, so they can reference `user`.
 */
export const migrations: readonly Migration[] = [
  {
    id: "001-artifacts",
    sql: `
      create table artifacts (
        id text not null primary key,
        title text not null,
        description text,
        originalFilename text not null,
        storageKey text not null unique,
        sha256 text not null,
        byteSize integer not null,
        createdBy text not null references "user" ("id"),
        createdAt integer not null,
        updatedAt integer not null
      );
      create index artifacts_created_at on artifacts (createdAt desc, id desc);
      create index artifacts_created_by on artifacts (createdBy);
    `,
  },
  {
    id: "002-artifact-markdown",
    sql: `
      create table artifactMarkdown (
        artifactId text not null primary key references artifacts (id) on delete cascade,
        converterVersion text not null,
        sourceSha256 text not null,
        markdown text not null,
        isEmpty integer not null,
        generatedAt integer not null
      );
    `,
  },
  {
    id: "003-status-archive-comments",
    sql: `
      alter table artifacts add column status text not null default 'open'
        check (status in ('open', 'solved'));
      alter table artifacts add column statusChangedAt integer;
      alter table artifacts add column statusChangedBy text references "user" ("id");
      alter table artifacts add column archivedAt integer;
      alter table artifacts add column archivedBy text references "user" ("id");
      create index artifacts_status on artifacts (status);
      create index artifacts_archived on artifacts (archivedAt);

      create table artifactComments (
        id text not null primary key,
        artifactId text not null references artifacts (id) on delete cascade,
        authorId text not null references "user" ("id"),
        body text not null,
        createdAt integer not null
      );
      create index artifactComments_artifact on artifactComments (artifactId, createdAt, id);
    `,
  },
  {
    id: "004-comment-anchors",
    sql: `
      alter table artifactComments add column anchor text;
    `,
  },
  {
    id: "005-comment-replies",
    sql: `
      alter table artifactComments add column parentId text
        references artifactComments (id) on delete cascade;
      create index artifactComments_parent on artifactComments (parentId);
    `,
  },
  {
    // Every artifact already stored becomes version 1 of itself, keeping its
    // id as the version id so its storage key stays derived from that id.
    // The markdown cache is rebuilt per version, so it is dropped rather than
    // migrated: it is only a cache.
    id: "006-artifact-versions",
    sql: `
      create table artifactVersions (
        id text not null primary key,
        artifactId text not null references artifacts (id) on delete cascade,
        number integer not null,
        originalFilename text not null,
        storageKey text not null unique,
        sha256 text not null,
        byteSize integer not null,
        createdBy text not null references "user" ("id"),
        createdAt integer not null,
        unique (artifactId, number)
      );
      insert into artifactVersions
        (id, artifactId, number, originalFilename, storageKey, sha256, byteSize, createdBy, createdAt)
      select id, id, 1, originalFilename, storageKey, sha256, byteSize, createdBy, createdAt
      from artifacts;

      alter table artifactComments add column versionId text
        references artifactVersions (id) on delete cascade;
      update artifactComments set versionId = artifactId;

      drop table artifactMarkdown;
      create table artifactMarkdown (
        versionId text not null primary key references artifactVersions (id) on delete cascade,
        converterVersion text not null,
        sourceSha256 text not null,
        markdown text not null,
        isEmpty integer not null,
        generatedAt integer not null
      );
    `,
  },
  {
    id: "007-folders-tags",
    sql: `
      create table folders (
        id text not null primary key,
        name text not null,
        parentId text references folders (id) on delete restrict,
        createdBy text not null references "user" ("id"),
        createdAt integer not null,
        updatedBy text not null references "user" ("id"),
        updatedAt integer not null
      );
      create unique index folders_parent_name on folders (coalesce(parentId, ''), name collate nocase);
      create index folders_parent on folders (parentId);

      create table tags (
        id text not null primary key,
        name text not null,
        createdBy text not null references "user" ("id"),
        createdAt integer not null,
        updatedBy text not null references "user" ("id"),
        updatedAt integer not null
      );
      create unique index tags_name on tags (name collate nocase);

      alter table artifacts add column folderId text references folders (id) on delete set null;
      create index artifacts_folder on artifacts (folderId);

      create table artifactTags (
        artifactId text not null references artifacts (id) on delete cascade,
        tagId text not null references tags (id) on delete cascade,
        createdBy text not null references "user" ("id"),
        createdAt integer not null,
        primary key (artifactId, tagId)
      );
      create index artifactTags_tag on artifactTags (tagId, artifactId);
    `,
  },
  {
    // Data an artifact's page and agents record: one value per person per key.
    // The schema a version declares for them is kept with that version.
    id: "008-artifact-entries",
    sql: `
      create table artifactEntries (
        artifactId text not null references artifacts (id) on delete cascade,
        authorId text not null references "user" ("id"),
        key text not null,
        value text not null,
        updatedAt integer not null,
        primary key (artifactId, authorId, key)
      );

      alter table artifactVersions add column entrySchema text;
    `,
  },
  {
    // The images a version's HTML loads as images/<name>. The set is fixed when
    // the version is uploaded, so an older version keeps its own images.
    id: "009-artifact-images",
    sql: `
      create table artifactImages (
        versionId text not null references artifactVersions (id) on delete cascade,
        name text not null,
        storageKey text not null,
        sha256 text not null,
        contentType text not null,
        byteSize integer not null,
        primary key (versionId, name)
      );
    `,
  },
  {
    id: "010-activity",
    sql: `
      create table artifactStatusChanges (
        id text not null primary key,
        artifactId text not null references artifacts (id) on delete cascade,
        change text not null check (change in ('solved', 'reopened', 'archived', 'restored')),
        actorId text not null references "user" ("id"),
        createdAt integer not null,
        inApp integer not null default 0
      );
      create index artifactStatusChanges_created_at on artifactStatusChanges (createdAt);
      alter table artifactVersions add column inApp integer not null default 0;
      alter table artifactComments add column inApp integer not null default 0;
      create index artifactVersions_created_at on artifactVersions (createdAt);
      create index artifactComments_created_at on artifactComments (createdAt);
      create table activityReads (
        userId text not null primary key references "user" ("id") on delete cascade,
        readAt integer not null
      );
    `,
  },
  {
    id: "011-artifact-visibility",
    sql: `
      alter table artifacts add column visibility text not null default 'shared'
        check (visibility in ('shared', 'private'));
    `,
  },
  {
    id: "012-user-avatars",
    sql: `
      create table userAvatars (
        userId text not null primary key references "user" ("id") on delete cascade,
        contentType text not null,
        bytes blob not null,
        updatedAt integer not null
      );
      create index artifactVersions_created_by on artifactVersions (createdBy, createdAt);
      create index artifactComments_author on artifactComments (authorId, createdAt);
    `,
  },
  {
    id: "013-user-display-names",
    sql: `
      create table userDisplayNames (
        userId text not null primary key references "user" ("id") on delete cascade,
        name text not null
      );
    `,
  },
  {
    // An entry whose key notifies shows in the activity feed from notifiedAt,
    // the last time its value changed, as activityId, made new at that time.
    id: "014-entry-activity",
    sql: `
      alter table artifactEntries add column notifiedAt integer;
      alter table artifactEntries add column activityId text;
      alter table artifactEntries add column inApp integer not null default 0;
      create index artifactEntries_notified_at on artifactEntries (notifiedAt);
    `,
  },
];

function ensureMigrationTable(database: Database): void {
  database.exec(`
    create table if not exists schema_migrations (
      id text not null primary key,
      appliedAt integer not null
    );
  `);
}

export function appliedMigrations(database: Database): string[] {
  ensureMigrationTable(database);
  const rows = database.query("select id from schema_migrations order by id").all() as {
    id: string;
  }[];
  return rows.map((row) => row.id);
}

/**
 * Applies the migrations that have not run yet, each in its own transaction,
 * and returns their ids. Running it again applies nothing.
 */
export function applyMigrations(database: Database): string[] {
  const applied = new Set(appliedMigrations(database));
  const ran: string[] = [];

  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    const run = database.transaction(() => {
      database.exec(migration.sql);
      database
        .query("insert into schema_migrations (id, appliedAt) values (?, ?)")
        .run(migration.id, Date.now());
    });
    run();
    ran.push(migration.id);
  }

  return ran;
}
