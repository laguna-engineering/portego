import { describe, expect, test } from "bun:test";
import { pngBytes } from "../storage/testing.ts";
import { ServiceError } from "./errors.ts";
import { checkImages, detectImageType, IMAGE_MAX_BYTES, isImageName } from "./images.ts";

const LIMITS = { maxImages: 3, maxTotalBytes: 25 * 1024 * 1024 };

function bytes(...parts: (string | number[])[]): Uint8Array {
  return new Uint8Array(
    Buffer.concat(
      parts.map((part) =>
        typeof part === "string" ? Buffer.from(part, "latin1") : Buffer.from(part),
      ),
    ),
  );
}

function refusal(run: () => unknown): ServiceError {
  try {
    run();
  } catch (error) {
    if (error instanceof ServiceError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("detectImageType", () => {
  test("recognises each raster type by its leading bytes", () => {
    expect(detectImageType(pngBytes())?.contentType).toBe("image/png");
    expect(detectImageType(bytes([0xff, 0xd8, 0xff, 0xe0]))?.contentType).toBe("image/jpeg");
    expect(detectImageType(bytes("GIF89a", [0, 0]))?.contentType).toBe("image/gif");
    expect(detectImageType(bytes("RIFF", [0, 0, 0, 0], "WEBPVP8 "))?.contentType).toBe(
      "image/webp",
    );
    expect(detectImageType(bytes([0, 0, 0, 24], "ftypavif", [0, 0, 0, 0], "mif1miaf"))).toEqual({
      extension: "avif",
      contentType: "image/avif",
    });
  });

  test("finds AVIF among the compatible brands, as some encoders write it", () => {
    expect(detectImageType(bytes([0, 0, 0, 28], "ftypmif1", [0, 0, 0, 0], "mif1miafavif"))).toEqual(
      { extension: "avif", contentType: "image/avif" },
    );
  });

  test("refuses SVG, which is a document that can carry script", () => {
    expect(detectImageType(bytes('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
  });

  test("refuses HTML whatever it is called", () => {
    expect(detectImageType(bytes("<!doctype html><script>alert(1)</script>"))).toBeNull();
  });

  test("refuses a HEIC file, whose ftyp box names no AVIF brand", () => {
    expect(detectImageType(bytes([0, 0, 0, 24], "ftypheic", [0, 0, 0, 0], "mif1heic"))).toBeNull();
  });
});

describe("isImageName", () => {
  test("accepts the names an agent writes in images/<name>", () => {
    expect(isImageName("chart.png")).toBe(true);
    expect(isImageName("Q3_revenue-2026.v2.jpeg")).toBe(true);
  });

  test("refuses anything that could be read as a path or needs URL encoding", () => {
    for (const name of ["../x.png", "a/b.png", "a\\b.png", ".hidden.png", "a b.png", "", "é.png"]) {
      expect(isImageName(name)).toBe(false);
    }
    expect(isImageName(`${"a".repeat(97)}.png`)).toBe(false);
  });
});

describe("checkImages", () => {
  test("returns each image with the type its bytes declare", () => {
    const [image] = checkImages([{ name: "photo.JPEG", bytes: bytes([0xff, 0xd8, 0xff]) }], LIMITS);
    expect(image).toMatchObject({
      name: "photo.JPEG",
      extension: "jpg",
      contentType: "image/jpeg",
    });
  });

  test("refuses an image whose name claims another type, so the extension never lies", () => {
    const error = refusal(() => checkImages([{ name: "chart.jpg", bytes: pngBytes() }], LIMITS));
    expect(error.code).toBe("UNSUPPORTED_CONTENT");
  });

  test("refuses HTML named as an image", () => {
    const error = refusal(() =>
      checkImages([{ name: "chart.png", bytes: bytes("<!doctype html><p>x") }], LIMITS),
    );
    expect(error.code).toBe("UNSUPPORTED_CONTENT");
  });

  test("refuses an image over 10 MiB", () => {
    const large = new Uint8Array(IMAGE_MAX_BYTES + 1);
    large.set(pngBytes());
    const error = refusal(() => checkImages([{ name: "big.png", bytes: large }], LIMITS));
    expect(error.code).toBe("FILE_TOO_LARGE");
  });

  test("accepts an image of exactly 10 MiB", () => {
    const edge = new Uint8Array(IMAGE_MAX_BYTES);
    edge.set(pngBytes());
    expect(checkImages([{ name: "edge.png", bytes: edge }], LIMITS)).toHaveLength(1);
  });

  test("refuses more images than the limit", () => {
    const images = ["a", "b", "c", "d"].map((name) => ({ name: `${name}.png`, bytes: pngBytes() }));
    expect(refusal(() => checkImages(images, LIMITS)).code).toBe("INVALID_INPUT");
  });

  test("refuses images whose combined size is over the limit", () => {
    const image = (name: string) => {
      const data = new Uint8Array(9 * 1024 * 1024);
      data.set(pngBytes());
      return { name, bytes: data };
    };
    const error = refusal(() =>
      checkImages([image("a.png"), image("b.png"), image("c.png")], LIMITS),
    );
    expect(error.code).toBe("FILE_TOO_LARGE");
  });

  test("refuses two images with one name, since the HTML could load only one", () => {
    const images = [
      { name: "a.png", bytes: pngBytes("1") },
      { name: "a.png", bytes: pngBytes("2") },
    ];
    expect(refusal(() => checkImages(images, LIMITS)).code).toBe("INVALID_INPUT");
  });

  test("refuses an empty image", () => {
    const error = refusal(() => checkImages([{ name: "a.png", bytes: new Uint8Array() }], LIMITS));
    expect(error.code).toBe("INVALID_INPUT");
  });
});
