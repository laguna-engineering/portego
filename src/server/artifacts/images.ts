import { ServiceError } from "./errors.ts";

/** The largest single image an upload may carry. */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_IMAGES = 20;
export const DEFAULT_MAX_IMAGE_BYTES_TOTAL = 50 * 1024 * 1024;

export type ImageType = { extension: string; contentType: string };

export type UploadedImage = { name: string; bytes: Uint8Array };

export type CheckedImage = UploadedImage & ImageType;

/**
 * The name an artifact's HTML uses in `images/<name>`. It is a single path
 * segment that needs no URL encoding, and it never becomes a file path.
 */
const IMAGE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function isImageName(name: string): boolean {
  return IMAGE_NAME_PATTERN.test(name);
}

const PNG = { extension: "png", contentType: "image/png" };
const JPEG = { extension: "jpg", contentType: "image/jpeg" };
const GIF = { extension: "gif", contentType: "image/gif" };
const WEBP = { extension: "webp", contentType: "image/webp" };
const AVIF = { extension: "avif", contentType: "image/avif" };

/** Which name extensions each type accepts. */
const EXTENSIONS: Record<string, string[]> = {
  png: ["png"],
  jpg: ["jpg", "jpeg"],
  gif: ["gif"],
  webp: ["webp"],
  avif: ["avif"],
};

/** Whether the name's extension is one the detected type accepts. */
export function nameMatchesType(name: string, type: ImageType): boolean {
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return EXTENSIONS[type.extension]?.includes(extension) ?? false;
}

function startsWith(bytes: Uint8Array, prefix: number[], offset = 0): boolean {
  if (bytes.byteLength < offset + prefix.length) return false;
  return prefix.every((byte, index) => bytes[offset + index] === byte);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

/**
 * The type comes from the bytes, never from the name or the declared MIME
 * type. SVG is absent on purpose: it is a document that can carry script.
 */
export function detectImageType(bytes: Uint8Array): ImageType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return PNG;
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return JPEG;
  if (bytes.byteLength >= 6 && /^GIF8[79]a$/.test(ascii(bytes, 0, 6))) return GIF;
  if (bytes.byteLength >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") {
    return WEBP;
  }
  // An ISO BMFF `ftyp` box whose major or compatible brands name AVIF.
  if (bytes.byteLength >= 16 && ascii(bytes, 4, 8) === "ftyp") {
    const boxSize = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0);
    const end = Math.min(boxSize, bytes.byteLength);
    for (let offset = 8; offset + 4 <= end; offset += 4) {
      // Bytes 12 to 16 hold the minor version, not a brand.
      if (offset === 12) continue;
      const brand = ascii(bytes, offset, offset + 4);
      if (brand === "avif" || brand === "avis") return AVIF;
    }
  }
  return null;
}

/**
 * Checks every image of one upload. One bad image refuses the whole upload,
 * so a version never goes live with some of its images missing.
 */
export function checkImages(
  images: UploadedImage[],
  limits: { maxImages: number; maxTotalBytes: number },
): CheckedImage[] {
  if (images.length > limits.maxImages) {
    throw new ServiceError(
      "INVALID_INPUT",
      `An upload carries at most ${limits.maxImages} images.`,
    );
  }
  const names = new Set<string>();
  let total = 0;
  return images.map((image) => {
    if (!isImageName(image.name)) {
      throw new ServiceError(
        "INVALID_INPUT",
        "An image name is 1 to 100 letters, digits, dots, dashes, or underscores, starting with a letter or digit.",
      );
    }
    if (names.has(image.name)) {
      throw new ServiceError("INVALID_INPUT", `Two images are named ${image.name}.`);
    }
    names.add(image.name);
    if (image.bytes.byteLength === 0) {
      throw new ServiceError("INVALID_INPUT", `The image ${image.name} is empty.`);
    }
    if (image.bytes.byteLength > IMAGE_MAX_BYTES) {
      throw new ServiceError(
        "FILE_TOO_LARGE",
        `The image ${image.name} is larger than the ${IMAGE_MAX_BYTES} byte limit.`,
      );
    }
    total += image.bytes.byteLength;
    if (total > limits.maxTotalBytes) {
      throw new ServiceError(
        "FILE_TOO_LARGE",
        `The images are larger than the ${limits.maxTotalBytes} byte limit for one upload.`,
      );
    }
    const type = detectImageType(image.bytes);
    if (!type) {
      throw new ServiceError(
        "UNSUPPORTED_CONTENT",
        `The image ${image.name} is not a PNG, JPEG, GIF, WebP, or AVIF file.`,
      );
    }
    if (!nameMatchesType(image.name, type)) {
      throw new ServiceError(
        "UNSUPPORTED_CONTENT",
        `The image ${image.name} holds ${type.contentType} data; its name must end in .${type.extension}.`,
      );
    }
    return { ...image, ...type };
  });
}
