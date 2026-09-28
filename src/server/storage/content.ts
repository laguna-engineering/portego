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

function sha256Hex(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return hasher.digest("hex");
}

/**
 * The bytes go to a temporary file first and only become visible under their
 * final name once they are on disk in full, so a failed or partial write leaves
 * nothing behind. The final link fails with EEXIST when the name is taken, so
 * no write ever replaces an existing file.
 */
async function writeNewFile(dataDir: string, target: string, bytes: Uint8Array): Promise<void> {
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
  } finally {
    await unlink(temp).catch(() => {});
  }
  await syncDirectory(dirname(target));
}

function isFileExists(cause: unknown): boolean {
  return (cause as NodeJS.ErrnoException).code === "EEXIST";
}

/**
 * Writes one artifact's bytes. Two uploads can never overwrite each other,
 * even if they somehow produced the same id.
 */
export async function writeContent(
  dataDir: string,
  id: string,
  bytes: Uint8Array,
): Promise<StoredContent> {
  const storageKey = storageKeyFor(id);
  try {
    await writeNewFile(dataDir, contentPath(dataDir, storageKey), bytes);
  } catch (cause) {
    if (isFileExists(cause)) throw new Error(`An artifact is already stored at ${storageKey}`);
    throw cause;
  }
  return { storageKey, sha256: sha256Hex(bytes), byteSize: bytes.byteLength };
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

/** Images live apart from the HTML, one directory per artifact. */
export function imagesDir(dataDir: string): string {
  return join(dataDir, "images");
}

/**
 * The key comes from the artifact id and the image's hash, never from the
 * name the uploader gave it. Equal bytes in one artifact share one file.
 */
export function imageStorageKeyFor(artifactId: string, sha256: string, extension: string): string {
  return `${artifactId}/${sha256}.${extension}`;
}

const IMAGE_KEY_PATTERN = /^[0-9a-f-]{36}\/[0-9a-f]{64}\.(png|jpg|gif|webp|avif)$/;

/** Refuses a key this module did not write, as contentPath does. */
export function imagePath(dataDir: string, storageKey: string): string {
  if (!IMAGE_KEY_PATTERN.test(storageKey)) {
    throw new Error(`Refusing to use image storage key ${JSON.stringify(storageKey)}`);
  }
  const root = resolve(imagesDir(dataDir));
  const path = resolve(root, storageKey);
  const inside = relative(root, path);
  if (inside.startsWith("..") || inside.startsWith(sep)) {
    throw new Error(`Refusing to use image storage key ${JSON.stringify(storageKey)}`);
  }
  return path;
}

/**
 * Stores an image under its hash. When the file is already there it holds
 * these same bytes, so it is reused and never rewritten.
 */
export async function writeImage(
  dataDir: string,
  artifactId: string,
  bytes: Uint8Array,
  extension: string,
): Promise<StoredContent> {
  const sha256 = sha256Hex(bytes);
  const storageKey = imageStorageKeyFor(artifactId, sha256, extension);
  try {
    await writeNewFile(dataDir, imagePath(dataDir, storageKey), bytes);
  } catch (cause) {
    if (!isFileExists(cause)) throw cause;
  }
  return { storageKey, sha256, byteSize: bytes.byteLength };
}

export async function readImage(dataDir: string, storageKey: string): Promise<Uint8Array | null> {
  const file = Bun.file(imagePath(dataDir, storageKey));
  if (!(await file.exists())) return null;
  return await file.bytes();
}

/** Removes one artifact's whole image directory. Only for an artifact no row points at. */
export async function removeArtifactImages(dataDir: string, artifactId: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/.test(artifactId)) {
    throw new Error(`Refusing to remove images of ${JSON.stringify(artifactId)}`);
  }
  await rm(join(imagesDir(dataDir), artifactId), { recursive: true, force: true });
}

/** Every stored image key. Used by the reconciliation report. */
export async function listStoredImageKeys(dataDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(imagesDir(dataDir), { recursive: true });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  }
  return entries
    .map((entry) => entry.split(sep).join("/"))
    .filter((entry) => entry.includes("/"))
    .sort();
}
