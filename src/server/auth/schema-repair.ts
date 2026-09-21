import type { Database } from "bun:sqlite";

/**
 * Repairs of Better Auth's own tables, for changes its migration does not make
 * itself. Deployment runs these from `migrate`, after Better Auth has migrated.
 */

/**
 * Drops the `account.issuer` column Better Auth 1.7.0 through 1.7.2 created.
 *
 * Later versions do not write that column and their migration does not remove
 * it, so on a database created by one of those versions it stays NOT NULL and
 * every insert into `account` fails. Sign-in then breaks for anyone who does
 * not already have an account row. The unique index over the column goes with
 * it, because a column an index covers cannot be dropped.
 *
 * Does nothing on a database that never had the column.
 */
export function dropLegacyAccountIssuer(database: Database): boolean {
  const columns = database.query("pragma table_info(account)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "issuer")) return false;

  database.exec(`
    drop index if exists "account_issuer_accountId_uidx";
    alter table "account" drop column "issuer";
  `);
  return true;
}
