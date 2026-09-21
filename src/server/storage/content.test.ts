import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  artifactsDir,
  contentPath,
  listStoredKeys,
  storageKeyFor,
  writeContent,
} from "./content.ts";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "content-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const id = "0199fd0c-1e2b-7c3d-8f00-1a2b3c4d5e6f";

describe("contentPath", () => {
  test("refuses a key that would climb out of the artifact directory", () => {
    expect(() => contentPath(dataDir, "../../etc/passwd.html")).toThrow(/Refusing/);
    expect(() => contentPath(dataDir, "ab/cd/../../../escape.html")).toThrow(/Refusing/);
  });

  test("refuses an absolute key", () => {
    expect(() => contentPath(dataDir, "/etc/passwd.html")).toThrow(/Refusing/);
  });

  test("refuses a key that is not the shape this module writes", () => {
    expect(() => contentPath(dataDir, "notes.txt")).toThrow(/Refusing/);
  });

  test("resolves a key it produced, inside the artifact directory", () => {
    expect(contentPath(dataDir, storageKeyFor(id)).startsWith(artifactsDir(dataDir))).toBe(true);
  });
});

describe("writeContent", () => {
  test("refuses to overwrite bytes that are already stored under that name", async () => {
    const first = new TextEncoder().encode("<p>first</p>");
    await writeContent(dataDir, id, first);

    await expect(
      writeContent(dataDir, id, new TextEncoder().encode("<p>second</p>")),
    ).rejects.toThrow(/already stored/);

    const stored = await Bun.file(contentPath(dataDir, storageKeyFor(id))).text();
    expect(stored).toBe("<p>first</p>");
  });

  test("reports the digest of the bytes it wrote", async () => {
    const bytes = new TextEncoder().encode("<p>content</p>");
    const stored = await writeContent(dataDir, id, bytes);
    expect(stored.sha256).toBe(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"));
    expect(stored.byteSize).toBe(bytes.byteLength);
  });
});

describe("listStoredKeys", () => {
  test("returns nothing before the first upload, rather than failing", async () => {
    expect(await listStoredKeys(dataDir)).toEqual([]);
  });

  test("returns the keys of stored files", async () => {
    await writeContent(dataDir, id, new TextEncoder().encode("<p>a</p>"));
    expect(await listStoredKeys(dataDir)).toEqual([storageKeyFor(id)]);
  });
});
