import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { artifactsDir, contentPath } from "./content.ts";
import { formatReport, reconcile } from "./reconcile.ts";
import { createTestStorage, htmlBytes, type TestStorage } from "./testing.ts";

let storage: TestStorage;

beforeEach(async () => {
  storage = await createTestStorage();
});

afterEach(() => {
  storage.cleanup();
});

async function create() {
  return storage.store.create({
    title: "A chart",
    originalFilename: "chart.html",
    content: htmlBytes("<h1>A chart</h1>"),
    createdBy: storage.userId,
  });
}

describe("reconcile", () => {
  test("reports agreement when every row has its file", async () => {
    await create();
    const report = await reconcile({ database: storage.database, dataDir: storage.dataDir });
    expect(report).toEqual({ missing: [], orphaned: [], checked: 1 });
  });

  test("reports a row whose file is gone", async () => {
    const artifact = await create();
    await Bun.file(contentPath(storage.dataDir, artifact.storageKey)).delete();

    const report = await reconcile({ database: storage.database, dataDir: storage.dataDir });
    expect(report.missing).toEqual([artifact.storageKey]);
    expect(report.orphaned).toEqual([]);
  });

  test("reports a file no row points at, which a failed restore can leave", async () => {
    const stray = join(artifactsDir(storage.dataDir), "ff/ee");
    mkdirSync(stray, { recursive: true });
    writeFileSync(join(stray, "stray.html"), "<p>stray</p>");

    const report = await reconcile({ database: storage.database, dataDir: storage.dataDir });
    expect(report.orphaned).toEqual(["ff/ee/stray.html"]);
  });

  test("deletes nothing, because a mismatch needs a person to decide", async () => {
    const artifact = await create();
    await reconcile({ database: storage.database, dataDir: storage.dataDir });
    expect(await Bun.file(contentPath(storage.dataDir, artifact.storageKey)).exists()).toBe(true);
    expect(storage.store.get(artifact.id)).not.toBeNull();
  });
});

describe("formatReport", () => {
  test("names each mismatch so the operator can act on it", () => {
    const text = formatReport(
      { missing: ["ab/cd/one.html"], orphaned: ["ef/12/two.html"], checked: 3 },
      "/var/lib/portego",
    );
    expect(text).toContain("Checked 3 versions");
    expect(text).toContain("missing file: ab/cd/one.html");
    expect(text).toContain("orphaned file: ef/12/two.html");
  });
});
