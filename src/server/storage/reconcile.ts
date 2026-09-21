/**
 * Compares the metadata in SQLite with the files on disk. Reports only:
 * deciding what to do about a mismatch needs a person who knows whether a
 * restore is in progress.
 *
 *   bun run reconcile
 */

import type { Database } from "bun:sqlite";
import { databasePath, openDatabase } from "../db.ts";
import { parseEnv } from "../env.ts";
import { createArtifactStore } from "./artifacts.ts";
import { artifactsDir, listStoredKeys } from "./content.ts";

export type ReconcileReport = {
  /** Rows whose file is absent. The artifact cannot be served. */
  missing: string[];
  /** Files no row points at. They waste space but serve nobody. */
  orphaned: string[];
  checked: number;
};

export async function reconcile(options: {
  database: Database;
  dataDir: string;
}): Promise<ReconcileReport> {
  const store = createArtifactStore(options);
  const known = new Set(store.storageKeys());
  const stored = new Set(await listStoredKeys(options.dataDir));

  return {
    missing: [...known].filter((key) => !stored.has(key)).sort(),
    orphaned: [...stored].filter((key) => !known.has(key)).sort(),
    checked: known.size,
  };
}

export function formatReport(report: ReconcileReport, dataDir: string): string {
  const lines = [`Checked ${report.checked} versions against ${artifactsDir(dataDir)}.`];
  for (const key of report.missing) lines.push(`missing file: ${key}`);
  for (const key of report.orphaned) lines.push(`orphaned file: ${key}`);
  if (report.missing.length === 0 && report.orphaned.length === 0) {
    lines.push("Metadata and files agree.");
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const env = parseEnv(Bun.env);
  const database = openDatabase(databasePath(env.DATA_DIR));
  try {
    const report = await reconcile({ database, dataDir: env.DATA_DIR });
    console.log(formatReport(report, env.DATA_DIR));
    // A mismatch is worth a non-zero exit so a deployment check can notice it.
    if (report.missing.length > 0 || report.orphaned.length > 0) process.exitCode = 1;
  } finally {
    database.close();
  }
}
