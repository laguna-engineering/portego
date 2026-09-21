import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** SQLite file inside the configured data directory. */
export function databasePath(dataDir: string): string {
  return join(dataDir, "app.db");
}

/**
 * Opens the application database. WAL keeps readers working while a write is in
 * progress, and the busy timeout lets a concurrent writer wait instead of
 * failing immediately.
 */
export function openDatabase(path: string): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}
