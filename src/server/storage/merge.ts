/**
 * Folds one artifact into another as further versions of it. For two uploads
 * of one document that became two artifacts.
 *
 *   bun run merge-artifacts <into-id> <from-id>
 */

import { databasePath, openDatabase } from "../db.ts";
import { parseEnv } from "../env.ts";
import { createArtifactStore } from "./artifacts.ts";

if (import.meta.main) {
  const [intoId, fromId] = Bun.argv.slice(2);
  if (!intoId || !fromId) {
    console.error("usage: bun run merge-artifacts <into-id> <from-id>");
    process.exit(2);
  }
  const env = parseEnv(Bun.env);
  const database = openDatabase(databasePath(env.DATA_DIR));
  try {
    const store = createArtifactStore({ database, dataDir: env.DATA_DIR });
    const merged = store.mergeInto(intoId, fromId);
    if (!merged) {
      console.error("Both ids must name existing, distinct artifacts.");
      process.exit(1);
    }
    console.log(
      `Merged ${fromId} into ${merged.id} ("${merged.title}"): now ${merged.versionCount} versions.`,
    );
  } finally {
    database.close();
  }
}
