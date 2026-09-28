/** Test support for storage. Every test gets its own directory and database. */
import type { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestAuth } from "../auth/testing.ts";
import { databasePath, openDatabase } from "../db.ts";
import { type ArtifactStore, createArtifactStore, type VersionImageInput } from "./artifacts.ts";
import { applyMigrations } from "./migrations.ts";

export type TestStorage = {
  store: ArtifactStore;
  database: Database;
  dataDir: string;
  /** A user row the artifacts can reference. */
  userId: string;
  reopen: () => { store: ArtifactStore; database: Database };
  cleanup: () => void;
};

export async function createTestStorage(): Promise<TestStorage> {
  const dataDir = await mkdtemp(join(tmpdir(), "artifacts-"));
  const database = openDatabase(databasePath(dataDir));

  // The artifacts table references the user table, so the auth schema has to
  // exist first, exactly as it does in a real deployment.
  await createTestAuth({ database });
  applyMigrations(database);

  const userId = "test-user";
  const now = Date.now();
  database
    .query(
      `insert into "user" (id, name, email, emailVerified, createdAt, updatedAt)
       values (?, ?, ?, 1, ?, ?)`,
    )
    .run(userId, "A Person", "person@acme.example", now, now);

  const opened: Database[] = [database];

  return {
    store: createArtifactStore({ database, dataDir }),
    database,
    dataDir,
    userId,
    reopen() {
      const reopened = openDatabase(databasePath(dataDir));
      opened.push(reopened);
      return { store: createArtifactStore({ database: reopened, dataDir }), database: reopened };
    },
    cleanup() {
      for (const db of opened) db.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export function htmlBytes(body: string): Uint8Array {
  return new TextEncoder().encode(`<!doctype html><title>t</title>${body}`);
}

/** A 1x1 PNG. A seed after the end chunk changes its hash and not the picture. */
export function pngBytes(seed = ""): Uint8Array<ArrayBuffer> {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  );
  return Uint8Array.from(Buffer.concat([png, Buffer.from(seed)]));
}

export function pngImage(name: string, seed = ""): VersionImageInput {
  return { name, bytes: pngBytes(seed), extension: "png", contentType: "image/png" };
}
