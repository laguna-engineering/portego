/**
 * The `account` table as Better Auth 1.7.2 created it, which is the shape every
 * database this service has deployed with is in.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { dropLegacyAccountIssuer } from "./schema-repair.ts";

const LEGACY_ACCOUNT = `
  create table "account" (
    "id" text not null primary key,
    "issuer" text not null,
    "accountId" text not null,
    "providerId" text not null,
    "userId" text not null,
    "createdAt" date not null,
    "updatedAt" date not null
  );
  create index "account_userId_idx" on "account" ("userId");
  create unique index "account_issuer_accountId_uidx" on "account" ("issuer", "accountId");
`;

const CURRENT_ACCOUNT = `
  create table "account" (
    "id" text not null primary key,
    "accountId" text not null,
    "providerId" text not null,
    "userId" text not null,
    "createdAt" date not null,
    "updatedAt" date not null
  );
  create index "account_userId_idx" on "account" ("userId");
`;

function database(schema: string): Database {
  const db = new Database(":memory:");
  db.exec(schema);
  return db;
}

function insertAccount(db: Database, id: string): void {
  db.query(
    `insert into "account" ("id", "accountId", "providerId", "userId", "createdAt", "updatedAt")
     values (?, 'subject-1', 'google', 'u1', 1, 1)`,
  ).run(id);
}

describe("dropLegacyAccountIssuer", () => {
  test("lets an account be written again", () => {
    const db = database(LEGACY_ACCOUNT);
    // What sign-in does for someone who has no account row yet.
    expect(() => insertAccount(db, "a1")).toThrow();

    expect(dropLegacyAccountIssuer(db)).toBe(true);

    expect(() => insertAccount(db, "a1")).not.toThrow();
  });

  test("takes the index over the column with it, and leaves the others", () => {
    const db = database(LEGACY_ACCOUNT);
    dropLegacyAccountIssuer(db);

    const indexes = (
      db
        .query("select name from sqlite_master where type = 'index' and tbl_name = 'account'")
        .all() as {
        name: string;
      }[]
    ).map((row) => row.name);
    expect(indexes).toContain("account_userId_idx");
    expect(indexes).not.toContain("account_issuer_accountId_uidx");
  });

  test("does nothing to a database that never had the column", () => {
    const db = database(CURRENT_ACCOUNT);
    expect(dropLegacyAccountIssuer(db)).toBe(false);
    expect(() => insertAccount(db, "a1")).not.toThrow();
  });

  test("applies nothing the second time, so deployment can run it every release", () => {
    const db = database(LEGACY_ACCOUNT);
    expect(dropLegacyAccountIssuer(db)).toBe(true);
    expect(dropLegacyAccountIssuer(db)).toBe(false);
  });
});
