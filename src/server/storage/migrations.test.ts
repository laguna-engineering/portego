import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { appliedMigrations, applyMigrations, migrations } from "./migrations.ts";

function database(): Database {
  const db = new Database(":memory:");
  // The artifacts table references the user table Better Auth owns.
  db.exec('create table "user" ("id" text not null primary key)');
  return db;
}

describe("applyMigrations", () => {
  test("applies every migration on a new database", () => {
    const db = database();
    expect(applyMigrations(db)).toEqual(migrations.map((migration) => migration.id));
    expect(appliedMigrations(db)).toEqual(migrations.map((migration) => migration.id));
  });

  test("applies nothing the second time, so deployment can run it every release", () => {
    const db = database();
    applyMigrations(db);
    expect(applyMigrations(db)).toEqual([]);
  });

  test("creates the artifacts table the store expects", () => {
    const db = database();
    applyMigrations(db);
    const columns = (db.query("pragma table_info(artifacts)").all() as { name: string }[]).map(
      (column) => column.name,
    );
    expect(columns).toEqual([
      "id",
      "title",
      "description",
      "originalFilename",
      "storageKey",
      "sha256",
      "byteSize",
      "createdBy",
      "createdAt",
      "updatedAt",
      "status",
      "statusChangedAt",
      "statusChangedBy",
      "archivedAt",
      "archivedBy",
      "folderId",
    ]);
  });

  test("gives artifacts that predate the status column a usable status", () => {
    const db = database();
    // Apply only the first migration, so the row is written by the old schema.
    const [first] = migrations;
    if (!first) throw new Error("expected a first migration");
    db.exec(first.sql);
    appliedMigrations(db);
    db.query('insert into "user" (id) values (?)').run("u1");
    db.query(
      `insert into artifacts
         (id, title, originalFilename, storageKey, sha256, byteSize, createdBy, createdAt, updatedAt)
       values ('old', 't', 'f.html', 'ab/cd/key.html', 'sha', 1, 'u1', 1, 1)`,
    ).run();
    db.query("insert into schema_migrations (id, appliedAt) values (?, ?)").run(first.id, 1);

    applyMigrations(db);

    const row = db.query("select status, archivedAt from artifacts where id = 'old'").get() as {
      status: string;
      archivedAt: number | null;
    };
    expect(row.status).toBe("open");
    expect(row.archivedAt).toBeNull();
  });

  test("refuses a status the application does not define, whatever writes it", () => {
    const db = database();
    applyMigrations(db);
    db.query('insert into "user" (id) values (?)').run("u1");
    db.query(
      `insert into artifacts
         (id, title, originalFilename, storageKey, sha256, byteSize, createdBy, createdAt, updatedAt)
       values ('a1', 't', 'f.html', 'ab/cd/key.html', 'sha', 1, 'u1', 1, 1)`,
    ).run();

    // The column has exactly two legal values, and a migration or a repair
    // script reaches the table without passing the service.
    expect(() => db.exec("update artifacts set status = 'in progress'")).toThrow();
    expect(() => db.exec("update artifacts set status = 'solved'")).not.toThrow();
  });

  test("refuses a second row for one storage key, so two artifacts cannot share a file", () => {
    const db = database();
    applyMigrations(db);
    db.query('insert into "user" (id) values (?)').run("u1");
    const insert = db.query(
      `insert into artifacts
         (id, title, originalFilename, storageKey, sha256, byteSize, createdBy, createdAt, updatedAt)
       values (?, 't', 'f.html', 'ab/cd/key.html', 'sha', 1, 'u1', 1, 1)`,
    );
    insert.run("a1");
    expect(() => insert.run("a2")).toThrow();
  });
});

describe("006-artifact-versions", () => {
  test("turns every existing artifact into version 1 of itself and keeps its comments", () => {
    const db = database();
    appliedMigrations(db);
    for (const migration of migrations.slice(0, 5)) {
      db.exec(migration.sql);
      db.query("insert into schema_migrations (id, appliedAt) values (?, ?)").run(migration.id, 1);
    }
    db.query('insert into "user" (id) values (?)').run("u1");
    db.query(
      `insert into artifacts
         (id, title, originalFilename, storageKey, sha256, byteSize, createdBy, createdAt, updatedAt)
       values ('a1', 't', 'f.html', 'ab/cd/key.html', 'sha', 1, 'u1', 5, 5)`,
    ).run();
    db.query(
      `insert into artifactComments (id, artifactId, authorId, body, createdAt)
       values ('c1', 'a1', 'u1', 'hello', 6)`,
    ).run();

    applyMigrations(db);

    expect(db.query("select * from artifactVersions").all()).toEqual([
      {
        id: "a1",
        artifactId: "a1",
        number: 1,
        originalFilename: "f.html",
        storageKey: "ab/cd/key.html",
        sha256: "sha",
        byteSize: 1,
        createdBy: "u1",
        createdAt: 5,
      },
    ]);
    expect(db.query("select versionId from artifactComments where id = 'c1'").get()).toEqual({
      versionId: "a1",
    });
  });

  test("refuses two versions with one number, so concurrent uploads cannot collide", () => {
    const db = database();
    applyMigrations(db);
    db.query('insert into "user" (id) values (?)').run("u1");
    db.query(
      `insert into artifacts
         (id, title, originalFilename, storageKey, sha256, byteSize, createdBy, createdAt, updatedAt)
       values ('a1', 't', 'f.html', 'ab/cd/key.html', 'sha', 1, 'u1', 1, 1)`,
    ).run();
    const insert = db.query(
      `insert into artifactVersions
         (id, artifactId, number, originalFilename, storageKey, sha256, byteSize, createdBy, createdAt)
       values (?, 'a1', 2, 'f.html', ?, 'sha', 1, 'u1', 1)`,
    );
    insert.run("v2", "ab/cd/v2.html");
    expect(() => insert.run("v2b", "ab/cd/v2b.html")).toThrow();
  });
});
