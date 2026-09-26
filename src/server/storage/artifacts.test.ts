import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ContentMissingError, InvalidCursorError, type ListSort } from "./artifacts.ts";
import { createCommentStore } from "./comments.ts";
import { artifactsDir, contentPath } from "./content.ts";
import { createEntryStore } from "./entries.ts";
import { createTestStorage, htmlBytes, type TestStorage } from "./testing.ts";

let storage: TestStorage;

beforeEach(async () => {
  storage = await createTestStorage();
});

afterEach(() => {
  storage.cleanup();
});

function input(overrides: Record<string, unknown> = {}) {
  return {
    title: "A chart",
    originalFilename: "chart.html",
    content: htmlBytes("<h1>A chart</h1>"),
    createdBy: storage.userId,
    ...overrides,
  };
}

describe("create", () => {
  test("records the digest and size of what it stored", async () => {
    const content = htmlBytes("<h1>A chart</h1>");
    const artifact = await storage.store.create(input({ content }));

    const expected = new Bun.CryptoHasher("sha256").update(content).digest("hex");
    expect(artifact.sha256).toBe(expected);
    expect(artifact.byteSize).toBe(content.byteLength);
  });

  test("writes the bytes outside the web root, under the data directory", async () => {
    const artifact = await storage.store.create(input());
    const path = contentPath(storage.dataDir, artifact.storageKey);
    expect(path.startsWith(artifactsDir(storage.dataDir))).toBe(true);
    expect(await Bun.file(path).text()).toContain("<h1>A chart</h1>");
  });

  test("names the file after the artifact id, never after the upload", async () => {
    const artifact = await storage.store.create(
      input({ originalFilename: "../../../etc/passwd.html" }),
    );
    expect(artifact.storageKey).toContain(artifact.id);
    expect(artifact.storageKey).not.toContain("passwd");
    expect(contentPath(storage.dataDir, artifact.storageKey)).toContain(
      artifactsDir(storage.dataDir),
    );
    // The original name is still recorded, because the download offers it back.
    expect(artifact.originalFilename).toBe("../../../etc/passwd.html");
  });

  test("keeps two simultaneous uploads apart", async () => {
    const [first, second] = await Promise.all([
      storage.store.create(input({ title: "First", content: htmlBytes("<p>first</p>") })),
      storage.store.create(input({ title: "Second", content: htmlBytes("<p>second</p>") })),
    ]);

    expect(first.id).not.toBe(second.id);
    expect(first.storageKey).not.toBe(second.storageKey);
    expect(await Bun.file(contentPath(storage.dataDir, first.storageKey)).text()).toContain(
      "first",
    );
    expect(await Bun.file(contentPath(storage.dataDir, second.storageKey)).text()).toContain(
      "second",
    );
  });

  test("leaves no temporary file behind", async () => {
    await storage.store.create(input());
    const temporary = readdirSync(join(storage.dataDir, "tmp"));
    expect(temporary).toEqual([]);
  });

  test("stores no file when the metadata cannot be written", async () => {
    // A creator the user table does not have violates the foreign key.
    await expect(storage.store.create(input({ createdBy: "nobody" }))).rejects.toThrow();

    const stored = readdirSync(artifactsDir(storage.dataDir), { recursive: true }) as string[];
    expect(stored.filter((entry) => entry.endsWith(".html"))).toEqual([]);
    expect(readdirSync(join(storage.dataDir, "tmp"))).toEqual([]);
  });
});

describe("durability", () => {
  test("keeps metadata and content across a restart", async () => {
    const artifact = await storage.store.create(input());
    const { store } = storage.reopen();

    expect(store.get(artifact.id)?.title).toBe("A chart");
    const read = await store.readContent(artifact.id);
    expect(new TextDecoder().decode(read?.content)).toContain("<h1>A chart</h1>");
  });
});

describe("read", () => {
  test("returns null for an id that does not exist", async () => {
    expect(await storage.store.readContent("missing")).toBeNull();
    expect(storage.store.get("missing")).toBeNull();
  });

  test("reports a row whose file disappeared instead of returning empty content", async () => {
    const artifact = await storage.store.create(input());
    await Bun.file(contentPath(storage.dataDir, artifact.storageKey)).delete();
    expect(existsSync(contentPath(storage.dataDir, artifact.storageKey))).toBe(false);

    await expect(storage.store.readContent(artifact.id)).rejects.toBeInstanceOf(
      ContentMissingError,
    );
  });
});

describe("list", () => {
  test("returns the most recently updated artifact first", async () => {
    const older = await storage.store.create(input({ title: "Older" }));
    await storage.store.create(input({ title: "Newer" }));
    expect(storage.store.list().items.map((item) => item.title)).toEqual(["Newer", "Older"]);

    // Whatever was touched last comes first, however old the upload is.
    storage.database
      .query("update artifacts set updatedAt = updatedAt + 1000 where id = ?")
      .run(older.id);
    expect(storage.store.list().items.map((item) => item.title)).toEqual(["Older", "Newer"]);
  });

  test("orders by creation time or title when asked", async () => {
    const first = await storage.store.create(input({ title: "banana" }));
    await storage.store.create(input({ title: "Apple" }));
    await storage.store.create(input({ title: "cherry" }));
    storage.database
      .query("update artifacts set updatedAt = updatedAt + 1000 where id = ?")
      .run(first.id);

    const titles = (sort: ListSort) => storage.store.list({ sort }).items.map((item) => item.title);
    expect(titles("updated-desc")).toEqual(["banana", "cherry", "Apple"]);
    expect(titles("updated-asc")).toEqual(["Apple", "cherry", "banana"]);
    expect(titles("created-desc")).toEqual(["cherry", "Apple", "banana"]);
    expect(titles("created-asc")).toEqual(["banana", "Apple", "cherry"]);
    // Title order ignores case, or every capitalised title would come first.
    expect(titles("title-asc")).toEqual(["Apple", "banana", "cherry"]);
    expect(titles("title-desc")).toEqual(["cherry", "banana", "Apple"]);
  });

  test("pages a title order without repeating or skipping a row", async () => {
    for (const title of ["b", "A", "a", "B", "c"]) {
      await storage.store.create(input({ title }));
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = storage.store.list({ sort: "title-asc", limit: 2, cursor });
      seen.push(...page.items.map((item) => item.title));
      cursor = page.nextCursor;
    } while (cursor);

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(seen.map((title) => title.toLowerCase())).toEqual(["a", "a", "b", "b", "c"]);
  });

  test("pages through rows that share a timestamp without repeating or skipping one", async () => {
    for (let index = 0; index < 5; index += 1) {
      await storage.store.create(input({ title: `Artifact ${index}` }));
    }
    // Force one timestamp for every row, the case a naive cursor gets wrong.
    storage.database.query("update artifacts set createdAt = 1000").run();

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = storage.store.list({ limit: 2, cursor });
      seen.push(...page.items.map((item) => item.title));
      cursor = page.nextCursor;
    } while (cursor);

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  test("stops offering a cursor on the last page", async () => {
    await storage.store.create(input());
    expect(storage.store.list({ limit: 10 }).nextCursor).toBeNull();
  });

  test("refuses a cursor it did not produce", () => {
    expect(() => storage.store.list({ cursor: "not-a-cursor" })).toThrow(InvalidCursorError);
  });

  test("refuses a cursor from a different order", async () => {
    await storage.store.create(input());
    await storage.store.create(input());
    const cursor = storage.store.list({ sort: "title-asc", limit: 1 }).nextCursor;
    expect(cursor).not.toBeNull();

    expect(() => storage.store.list({ sort: "created-desc", cursor })).toThrow(InvalidCursorError);
  });

  test("keeps only the artifacts matching a search term", async () => {
    await storage.store.create(input({ title: "Sales chart" }));
    await storage.store.create(input({ title: "Latency report", description: "p99 by region" }));

    expect(storage.store.list({ query: "chart" }).items.map((item) => item.title)).toEqual([
      "Sales chart",
    ]);
    expect(storage.store.list({ query: "p99" }).items.map((item) => item.title)).toEqual([
      "Latency report",
    ]);
  });

  test("reads a wildcard in a search term as text, not as a pattern", async () => {
    await storage.store.create(input({ title: "Anything" }));
    await storage.store.create(input({ title: "100% coverage" }));

    expect(storage.store.list({ query: "100%" }).items.map((item) => item.title)).toEqual([
      "100% coverage",
    ]);
    expect(storage.store.list({ query: "_" }).items).toHaveLength(0);
  });

  test("caps the page size a caller can ask for", async () => {
    await storage.store.create(input());
    expect(storage.store.list({ limit: 10_000 }).items).toHaveLength(1);
  });
});

describe("versions", () => {
  test("stores each upload as the next version and shows the latest on the artifact", async () => {
    const first = await storage.store.create(input({ title: "Report" }));
    const second = await storage.store.addVersion({
      artifactId: first.id,
      originalFilename: "report-v2.html",
      content: htmlBytes("<h1>Report, revised</h1>"),
      createdBy: storage.userId,
    });
    if (!second) throw new Error("expected the artifact back");

    expect(first.versionCount).toBe(1);
    expect(second.versionCount).toBe(2);
    expect(second.originalFilename).toBe("report-v2.html");
    expect(second.sha256).not.toBe(first.sha256);
    expect(second.updatedAt.getTime()).toBeGreaterThanOrEqual(first.updatedAt.getTime());
    expect(second.createdAt).toEqual(first.createdAt);

    const versions = storage.store.versions(first.id);
    expect(versions.map((version) => version.number)).toEqual([2, 1]);
    expect(versions[0]?.id).toBe(second.currentVersionId);
    // Version 1 is the artifact itself, which is what its file was named after.
    expect(versions[1]?.id).toBe(first.id);
    expect(versions[1]?.sha256).toBe(first.sha256);
  });

  test("keeps every version's bytes readable", async () => {
    const artifact = await storage.store.create(input({ content: htmlBytes("<p>one</p>") }));
    await storage.store.addVersion({
      artifactId: artifact.id,
      originalFilename: "two.html",
      content: htmlBytes("<p>two</p>"),
      createdBy: storage.userId,
    });
    const [latest, oldest] = storage.store.versions(artifact.id);
    if (!latest || !oldest) throw new Error("expected two versions");

    const old = await storage.store.readVersionContent(oldest.id);
    const current = await storage.store.readContent(artifact.id);
    expect(new TextDecoder().decode(old?.content)).toContain("one");
    expect(new TextDecoder().decode(current?.content)).toContain("two");
    expect(storage.store.storageKeys()).toEqual([latest.storageKey, oldest.storageKey].sort());
  });

  test("keeps the description unless the new version brings one", async () => {
    const artifact = await storage.store.create(input({ description: "The first take" }));
    const kept = await storage.store.addVersion({
      artifactId: artifact.id,
      originalFilename: "a.html",
      content: htmlBytes("<p>2</p>"),
      createdBy: storage.userId,
    });
    expect(kept?.description).toBe("The first take");

    const replaced = await storage.store.addVersion({
      artifactId: artifact.id,
      description: "The second take",
      originalFilename: "a.html",
      content: htmlBytes("<p>3</p>"),
      createdBy: storage.userId,
    });
    expect(replaced?.description).toBe("The second take");
  });

  test("returns null and stores no file for an artifact that does not exist", async () => {
    const result = await storage.store.addVersion({
      artifactId: "missing",
      originalFilename: "a.html",
      content: htmlBytes("<p>x</p>"),
      createdBy: storage.userId,
    });
    expect(result).toBeNull();
    expect(storage.store.storageKeys()).toEqual([]);
  });

  test("finds the artifact a re-upload belongs to by its exact title, skipping archived ones", async () => {
    const archived = await storage.store.create(input({ title: "Report" }));
    storage.store.setArchived(archived.id, true, storage.userId);
    const live = await storage.store.create(input({ title: "Report" }));
    await storage.store.create(input({ title: "report" }));

    expect(storage.store.findByTitle("Report")?.id).toBe(live.id);
    expect(storage.store.findByTitle("Reports")).toBeNull();
  });
});

describe("mergeInto", () => {
  test("folds a duplicate artifact in as later versions, in upload order", async () => {
    const older = await storage.store.create(
      input({ title: "Targets", content: htmlBytes("<p>first</p>") }),
    );
    const newer = await storage.store.create(
      input({ title: "Targets", description: "With photos", content: htmlBytes("<p>second</p>") }),
    );
    storage.database
      .query("update artifactVersions set createdAt = createdAt + 1000 where id = ?")
      .run(newer.id);
    const comments = createCommentStore({ database: storage.database });
    const comment = comments.add({
      artifactId: newer.id,
      versionId: newer.currentVersionId,
      authorId: storage.userId,
      body: "on the newer one",
    });

    storage.database
      .query(
        `insert into tags (id, name, createdBy, createdAt, updatedBy, updatedAt)
         values ('shared', 'Shared', ?, 1, ?, 1), ('newer', 'Newer', ?, 1, ?, 1)`,
      )
      .run(storage.userId, storage.userId, storage.userId, storage.userId);
    storage.database
      .query(
        `insert into artifactTags (artifactId, tagId, createdBy, createdAt)
         values (?, 'shared', ?, 1), (?, 'shared', ?, 1), (?, 'newer', ?, 1)`,
      )
      .run(older.id, storage.userId, newer.id, storage.userId, newer.id, storage.userId);

    const merged = storage.store.mergeInto(older.id, newer.id);
    if (!merged) throw new Error("expected the merged artifact");

    expect(merged.id).toBe(older.id);
    expect(merged.versionCount).toBe(2);
    expect(merged.sha256).toBe(newer.sha256);
    // The older artifact had no description, so the duplicate's is kept.
    expect(merged.description).toBe("With photos");
    expect(storage.store.versions(older.id).map((version) => [version.number, version.id])).toEqual(
      [
        [2, newer.id],
        [1, older.id],
      ],
    );
    expect(storage.store.get(newer.id)).toBeNull();
    expect(comments.get(comment.id)?.artifactId).toBe(older.id);
    expect(comments.get(comment.id)?.versionNumber).toBe(2);
    expect(
      storage.database
        .query("select tagId from artifactTags where artifactId = ? order by tagId")
        .all(older.id),
    ).toEqual([{ tagId: "newer" }, { tagId: "shared" }]);
    // Both files are still accounted for.
    expect(storage.store.storageKeys()).toHaveLength(2);
  });

  test("keeps entries from both, and a person's newer value where both have the key", async () => {
    const older = await storage.store.create(input({ title: "Poll" }));
    const newer = await storage.store.create(input({ title: "Poll" }));
    const entries = createEntryStore({ database: storage.database });
    const write = (artifactId: string, key: string, value: string, updatedAt: number) =>
      storage.database
        .query(
          "insert into artifactEntries (artifactId, authorId, key, value, updatedAt) values (?, ?, ?, ?, ?)",
        )
        .run(artifactId, storage.userId, key, JSON.stringify(value), updatedAt);
    write(older.id, "poll", "stale", 1);
    write(newer.id, "poll", "fresh", 2);
    write(older.id, "only-older", "a", 1);
    write(newer.id, "only-newer", "b", 1);

    storage.store.mergeInto(older.id, newer.id);

    const merged = Object.fromEntries(
      entries.list(older.id).map((entry) => [entry.key, entry.value]),
    );
    expect(merged).toEqual({ poll: "fresh", "only-older": "a", "only-newer": "b" });
    expect(entries.list(newer.id)).toEqual([]);
  });

  test("refuses to merge an artifact into itself or into nothing", async () => {
    const artifact = await storage.store.create(input());
    expect(storage.store.mergeInto(artifact.id, artifact.id)).toBeNull();
    expect(storage.store.mergeInto(artifact.id, "missing")).toBeNull();
    expect(storage.store.get(artifact.id)?.versionCount).toBe(1);
  });
});
