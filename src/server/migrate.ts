/**
 * Applies the database schema. Deployment runs this explicitly before starting
 * the server; the server itself never migrates on boot.
 *
 *   bun run migrate
 */
import { getMigrations } from "better-auth/db/migration";
import { createAuth } from "./auth/auth.ts";
import { parseAuthConfig } from "./auth/config.ts";
import { dropLegacyAccountIssuer } from "./auth/schema-repair.ts";
import { databasePath, openDatabase } from "./db.ts";
import { parseEnv } from "./env.ts";
import { applyMigrations } from "./storage/migrations.ts";

// Better Auth accepts an array field only in a column whose type name contains
// "json", but on SQLite it creates those columns as TEXT itself. The check
// then warns about every array field on every run.
const ARRAY_COLUMN_MISMATCH = /Expected (string|number)\[\] but got TEXT\.$/;

function logUnlessArrayColumnMismatch(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  ...args: unknown[]
): void {
  if (ARRAY_COLUMN_MISMATCH.test(message)) return;
  console[level](`[Better Auth] ${message}`, ...args);
}

export async function migrate(): Promise<void> {
  const env = parseEnv(Bun.env);
  const config = parseAuthConfig(env, Bun.env);
  const path = databasePath(env.DATA_DIR);
  const database = openDatabase(path);

  try {
    // Better Auth owns its own tables and migrates them first, because the
    // application tables reference `user`.
    const auth = createAuth({ config, database });
    // The auth context finishes starting in the background and reads the
    // database as it does. Closing the database under it fails the script
    // after the schema was already applied.
    await auth.$context;
    const { toBeCreated, toBeAdded, runMigrations } = await getMigrations({
      ...auth.options,
      logger: { log: logUnlessArrayColumnMismatch },
    });
    const authChanges = [...toBeCreated, ...toBeAdded].map((change) => change.table);
    if (authChanges.length > 0) await runMigrations();
    // Better Auth leaves a column behind that it no longer writes. It has to
    // go before anything inserts into `account`.
    const repaired = dropLegacyAccountIssuer(database) ? ["account.issuer (dropped)"] : [];

    const applied = applyMigrations(database);
    const changes = [...authChanges, ...repaired, ...applied];
    if (changes.length === 0) {
      console.log(`No schema changes for ${path}.`);
      return;
    }
    console.log(`Applied schema changes to ${path}: ${changes.join(", ")}.`);
  } finally {
    database.close();
  }
}

if (import.meta.main) {
  await migrate();
}
