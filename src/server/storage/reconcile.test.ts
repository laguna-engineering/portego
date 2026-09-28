import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { artifactsDir, contentPath, imagePath, imagesDir } from "./content.ts";
import { formatReport, reconcile } from "./reconcile.ts";
import { createTestStorage, htmlBytes, pngImage, type TestStorage } from "./testing.ts";

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
    content: htmlBytes('<img src="images/chart.png">'),
    images: [pngImage("chart.png")],
    createdBy: storage.userId,
  });
}

describe("reconcile", () => {
  test("reports agreement when every row has its file", async () => {
    await create();
    const report = await reconcile({ database: storage.database, dataDir: storage.dataDir });
    expect(report).toEqual({
      missing: [],
      orphaned: [],
      checked: 1,
      images: { missing: [], orphaned: [], checked: 1 },
    });
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

  test("reports an image row whose file is gone", async () => {
    const artifact = await create();
    const [key = ""] = storage.store.imageStorageKeys();
    await Bun.file(imagePath(storage.dataDir, key)).delete();

    const report = await reconcile({ database: storage.database, dataDir: storage.dataDir });
    expect(report.images.missing).toEqual([key]);
    expect(key.startsWith(`${artifact.id}/`)).toBe(true);
  });

  test("reports an image file no row points at, which a failed version upload can leave", async () => {
    const stray = join(imagesDir(storage.dataDir), "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b");
    mkdirSync(stray, { recursive: true });
    writeFileSync(join(stray, `${"a".repeat(64)}.png`), "stray");

    const report = await reconcile({ database: storage.database, dataDir: storage.dataDir });
    expect(report.images.orphaned).toEqual([
      `0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b/${"a".repeat(64)}.png`,
    ]);
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
      {
        missing: ["ab/cd/one.html"],
        orphaned: ["ef/12/two.html"],
        checked: 3,
        images: { missing: ["x/one.png"], orphaned: ["y/two.png"], checked: 2 },
      },
      "/var/lib/portego",
    );
    expect(text).toContain("Checked 3 versions");
    expect(text).toContain("missing file: ab/cd/one.html");
    expect(text).toContain("orphaned file: ef/12/two.html");
    expect(text).toContain("Checked 2 images");
    expect(text).toContain("missing image: x/one.png");
    expect(text).toContain("orphaned image: y/two.png");
  });
});
