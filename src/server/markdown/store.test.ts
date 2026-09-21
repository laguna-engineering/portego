import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestStorage, htmlBytes, type TestStorage } from "../storage/testing.ts";
import { createMarkdownStore, type MarkdownStore } from "./store.ts";

let storage: TestStorage;
let store: MarkdownStore;
let versionId: string;

beforeEach(async () => {
  storage = await createTestStorage();
  store = createMarkdownStore({ database: storage.database });
  const artifact = await storage.store.create({
    title: "A chart",
    originalFilename: "chart.html",
    content: htmlBytes("<h1>A chart</h1>"),
    createdBy: storage.userId,
  });
  versionId = artifact.currentVersionId;
});

afterEach(() => {
  storage.cleanup();
});

function write(overrides: { converterVersion?: string; sourceSha256?: string } = {}) {
  return store.write({
    versionId,
    sourceSha256: overrides.sourceSha256 ?? "digest-1",
    converterVersion: overrides.converterVersion ?? "1",
    markdown: "# A chart",
    empty: false,
  });
}

describe("createMarkdownStore", () => {
  test("returns a conversion of the same source by the same converter", () => {
    write();
    expect(store.read(versionId, "digest-1", "1")).toMatchObject({
      markdown: "# A chart",
      empty: false,
    });
  });

  test("ignores a conversion made by an older converter, so output stays current", () => {
    write({ converterVersion: "0" });
    expect(store.read(versionId, "digest-1", "1")).toBeNull();
  });

  test("ignores a conversion of different source bytes", () => {
    write();
    expect(store.read(versionId, "digest-2", "1")).toBeNull();
  });

  test("keeps one conversion per artifact, replacing what was there", () => {
    write({ converterVersion: "0" });
    write({ converterVersion: "1" });

    const rows = storage.database.query("select count(*) as count from artifactMarkdown").get() as {
      count: number;
    };
    expect(rows.count).toBe(1);
    expect(store.read(versionId, "digest-1", "1")).not.toBeNull();
  });

  test("records an empty conversion as empty rather than as a miss", () => {
    store.write({
      versionId,
      sourceSha256: "digest-1",
      converterVersion: "1",
      markdown: "",
      empty: true,
    });
    expect(store.read(versionId, "digest-1", "1")).toMatchObject({ markdown: "", empty: true });
  });
});
