import { link, mkdir, open, readdir, rm, unlink } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

export type StoredContent = { storageKey: string; sha256: string; byteSize: number };

/** Uploaded files live here, outside the static web root. */
export function artifactsDir(dataDir: string): string {
  return join(dataDir, "artifacts");
}

function tempDir(dataDir: string): string {
  return join(dataDir, "tmp");
}

/**
 * The storage key comes from the artifact id, never from the uploaded
 * filename, so no upload can choose where its bytes land. Two levels of
 * directory keep any single directory small.
 */
export function storageKeyFor(id: string): string {
  return `${id.slice(0, 2)}/${id.slice(2, 4)}/${id}.html`;
}

const STORAGE_KEY_PATTERN = /^[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f-]{36}\.html$/;

/**
 * Resolves a storage key to a path. A key that does not have the shape this
 * module writes is refused, so a corrupted or tampered database row cannot
 * reach a file outside the artifact directory.
 */
export function contentPath(dataDir: string, storageKey: string): string {
  if (!STORAGE_KEY_PATTERN.test(storageKey)) {
    throw new Error(`Refusing to use storage key ${JSON.stringify(storageKey)}`);
  }
  const root = resolve(artifactsDir(dataDir));
  const path = resolve(root, storageKey);
  const inside = relative(root, path);
  if (inside.startsWith("..") || inside.startsWith(sep)) {
    throw new Error(`Refusing to use storage key ${JSON.stringify(storageKey)}`);
  }
  return path;
}

/** Best effort. A directory entry that is not durable yet is not a lost artifact. */
async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Some platforms refuse to open a directory for reading.
  }
}

/**
 * Writes one artifact's bytes. The bytes go to a temporary file first and only
 * become visible under their final name once they are on disk in full, so a
 * failed or partial write leaves no artifact behind.
 *
 * The final link fails when the name is taken, so two uploads can never
 * overwrite each other even if they somehow produced the same id.
 */
export async function writeContent(
  dataDir: string,
  id: string,
  bytes: Uint8Array,
): Promise<StoredContent> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  const sha256 = hasher.digest("hex");

  const storageKey = storageKeyFor(id);
  const target = contentPath(dataDir, storageKey);
  const temp = join(tempDir(dataDir), `${crypto.randomUUID()}.part`);

  await mkdir(dirname(target), { recursive: true });
  await mkdir(tempDir(dataDir), { recursive: true });

  const handle = await open(temp, "wx", 0o640);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await link(temp, target);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`An artifact is already stored at ${storageKey}`);
    }
    throw cause;
  } finally {
    await unlink(temp).catch(() => {});
  }
  await syncDirectory(dirname(target));

  return { storageKey, sha256, byteSize: bytes.byteLength };
}

export async function readContent(dataDir: string, storageKey: string): Promise<Uint8Array | null> {
  const file = Bun.file(contentPath(dataDir, storageKey));
  if (!(await file.exists())) return null;
  return await file.bytes();
}

export async function removeContent(dataDir: string, storageKey: string): Promise<void> {
  await rm(contentPath(dataDir, storageKey), { force: true });
}

/** Every stored key. Used by the reconciliation report. */
export async function listStoredKeys(dataDir: string): Promise<string[]> {
  const root = artifactsDir(dataDir);
  let entries: string[];
  try {
    entries = await readdir(root, { recursive: true });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  }
  return entries
    .map((entry) => entry.split(sep).join("/"))
    .filter((entry) => entry.endsWith(".html"))
    .sort();
}
