import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { databasePath, openDatabase } from "./db.ts";

describe("openDatabase", () => {
  test("creates the data directory, so a first start needs no manual setup", () => {
    const dir = mkdtempSync(join(tmpdir(), "data-"));
    try {
      const path = databasePath(join(dir, "nested"));
      const db = openDatabase(path);
      db.close();
      expect(existsSync(path)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("uses WAL, so a reader is not blocked while an upload is being written", () => {
    const dir = mkdtempSync(join(tmpdir(), "data-"));
    try {
      const db = openDatabase(databasePath(dir));
      expect(db.query("pragma journal_mode").get()).toMatchObject({ journal_mode: "wal" });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("enforces foreign keys, which SQLite leaves off by default", () => {
    const dir = mkdtempSync(join(tmpdir(), "data-"));
    try {
      const db = openDatabase(databasePath(dir));
      expect(db.query("pragma foreign_keys").get()).toMatchObject({ foreign_keys: 1 });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
