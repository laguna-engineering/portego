import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pngBytes } from "../../src/server/storage/testing.ts";
import { checkImageLimits, INLINE_IMAGE_MAX_BYTES, resolveLocalImages } from "./images.ts";
import { finalizeArtifact, prepareArtifactDraft, validateArtifactFile } from "./style.ts";

const directories: string[] = [];

async function folder(images: Record<string, Uint8Array | string> = {}): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "portego-images-"));
  directories.push(directory);
  await mkdir(join(directory, "images"));
  for (const [name, bytes] of Object.entries(images)) {
    await writeFile(join(directory, "images", name), bytes);
  }
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** A PNG over the inline limit, so it stays a file. */
function largePng(seed = ""): Uint8Array {
  const bytes = new Uint8Array(INLINE_IMAGE_MAX_BYTES + 1);
  bytes.set(pngBytes(seed));
  return bytes;
}

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>';

function page(body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Report</title></head><body><h1>Report</h1>${body}</body></html>`;
}

describe("resolveLocalImages", () => {
  test("embeds a small image and keeps a large one as a file to upload", async () => {
    const directory = await folder({ "icon.png": pngBytes(), "chart.png": largePng() });
    const html = page('<img src="images/icon.png" alt=""><img src="images/chart.png" alt="Chart">');

    const resolved = await resolveLocalImages(html, directory);

    expect(resolved.issues).toEqual([]);
    expect(resolved.html).toContain(
      `src="data:image/png;base64,${Buffer.from(pngBytes()).toString("base64")}"`,
    );
    expect(resolved.html).toContain('src="images/chart.png"');
    expect(resolved.files.map((file) => file.name)).toEqual(["chart.png"]);
  });

  test("embeds SVG at any size, since the server refuses it as a file", async () => {
    const large = SVG.replace("></svg>", `>${" ".repeat(INLINE_IMAGE_MAX_BYTES)}</svg>`);
    const directory = await folder({ "diagram.svg": large });

    const resolved = await resolveLocalImages(
      page('<img src="images/diagram.svg" alt="">'),
      directory,
    );

    expect(resolved.files).toEqual([]);
    expect(resolved.html).toContain('src="data:image/svg+xml;base64,');
  });

  test("embeds small images named in CSS, in a style element and in a style attribute", async () => {
    const directory = await folder({ "dot.png": pngBytes() });
    const html = page(
      `<style>.a { background: url("images/dot.png"); }</style><div style="background: url('images/dot.png')"></div>`,
    );

    const resolved = await resolveLocalImages(html, directory);

    expect(resolved.html).not.toContain("images/dot.png");
    expect(resolved.html).toContain(".a { background: url(data:image/png;base64,");
    // The attribute stays one attribute: the quotes the author used are gone
    // and nothing in the data URI needs escaping.
    expect(resolved.html).toMatch(/<div style="background: url\(data:image\/png;base64,[^"]+\)">/);
  });

  test("changes nothing but the image references", async () => {
    const directory = await folder({ "icon.png": pngBytes() });
    const text = '<p>Write <code>&lt;img src="images/icon.png"&gt;</code> to add one.</p>';
    const html = page(`<img  alt="" src = 'images/icon.png' >${text}`);

    const resolved = await resolveLocalImages(html, directory);

    expect(resolved.html).toContain(text);
    expect(resolved.html.replace(/src="data:[^"]+"/, "SRC")).toBe(
      html.replace("src = 'images/icon.png'", "SRC"),
    );
  });

  test("leaves a document with no image references byte for byte the same", async () => {
    const html = page('<img src="data:image/png;base64,AAAA" alt="">');
    expect((await resolveLocalImages(html, await folder())).html).toBe(html);
  });

  test("reports a missing image instead of uploading a page that shows a broken one", async () => {
    const resolved = await resolveLocalImages(
      page('<img src="images/gone.png" alt="">'),
      await folder(),
    );
    expect(resolved.issues.map((issue) => issue.code)).toEqual(["image-missing"]);
  });

  test("refuses a name that could reach outside the images folder", async () => {
    const directory = await folder();
    await writeFile(join(directory, "secret.png"), pngBytes());
    const resolved = await resolveLocalImages(
      page('<img src="images/../secret.png" alt="">'),
      directory,
    );
    expect(resolved.issues.map((issue) => issue.code)).toEqual(["image-name"]);
    expect(resolved.files).toEqual([]);
  });

  test("refuses a symlink, so the folder cannot point the upload at another file", async () => {
    const directory = await folder();
    const outside = join(directory, "private.png");
    await writeFile(outside, largePng());
    await symlink(outside, join(directory, "images", "chart.png"));

    const resolved = await resolveLocalImages(
      page('<img src="images/chart.png" alt="">'),
      directory,
    );
    expect(resolved.issues.map((issue) => issue.code)).toEqual(["image-file"]);
    expect(resolved.files).toEqual([]);
  });

  test("refuses a file that is not an image, whatever its name says", async () => {
    const directory = await folder({ "notes.png": "these are my notes" });
    const resolved = await resolveLocalImages(
      page('<img src="images/notes.png" alt="">'),
      directory,
    );
    expect(resolved.issues.map((issue) => issue.code)).toEqual(["image-type"]);
  });

  test("refuses an image over 10 MiB before reading it", async () => {
    const directory = await folder({ "huge.png": pngBytes() });
    await truncate(join(directory, "images", "huge.png"), 10 * 1024 * 1024 + 1);
    const resolved = await resolveLocalImages(
      page('<img src="images/huge.png" alt="">'),
      directory,
    );
    expect(resolved.issues.map((issue) => issue.code)).toEqual(["image-size"]);
  });

  test("uploads an image named twice only once", async () => {
    const directory = await folder({ "chart.png": largePng() });
    const html = page('<img src="images/chart.png" alt=""><img src="images/chart.png" alt="">');
    expect((await resolveLocalImages(html, directory)).files).toHaveLength(1);
  });
});

describe("checkImageLimits", () => {
  test("holds an upload to the deployment's count and total size", () => {
    const files = [
      { name: "a.png", bytes: Buffer.alloc(10) },
      { name: "b.png", bytes: Buffer.alloc(10) },
    ];
    expect(checkImageLimits(files, { maxImages: 2, maxImageBytesTotal: 20 })).toEqual([]);
    expect(
      checkImageLimits(files, { maxImages: 1, maxImageBytesTotal: 19 }).map((issue) => issue.code),
    ).toEqual(["image-count", "image-total-size"]);
  });
});

describe("validateArtifactFile", () => {
  test("accepts image files next to the document and lists the ones to upload", async () => {
    const directory = await folder({ "chart.png": largePng(), "icon.png": pngBytes() });
    const path = join(directory, "report.html");
    await writeFile(
      path,
      page('<img src="images/chart.png" alt="Chart"><img src="images/icon.png" alt="">'),
    );

    const result = await validateArtifactFile(path);
    expect(result.valid).toBe(true);
    expect(result.imageFiles).toEqual(["chart.png"]);
  });

  test("still refuses an image from anywhere else", async () => {
    const directory = await folder();
    const path = join(directory, "report.html");
    await writeFile(path, page('<img src="https://example.com/chart.png" alt="">'));

    const result = await validateArtifactFile(path);
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("external-resource");
  });

  test("counts embedded images toward the document's size", async () => {
    const directory = await folder({ "icon.png": pngBytes() });
    const path = join(directory, "report.html");
    const html = page('<img src="images/icon.png" alt="">');
    await writeFile(path, html);

    const result = await validateArtifactFile(path);
    expect(result.byteSize).toBeGreaterThan(Buffer.byteLength(html));
  });

  test("reports more image files than the upload limit", async () => {
    const directory = await folder({ "a.png": largePng("a"), "b.png": largePng("b") });
    const path = join(directory, "report.html");
    await writeFile(path, page('<img src="images/a.png" alt=""><img src="images/b.png" alt="">'));

    const result = await validateArtifactFile(path, undefined, {
      maxImages: 1,
      maxImageBytesTotal: 50 * 1024 * 1024,
    });
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("image-count");
  });
});

describe("finalizeArtifact with images", () => {
  async function draftWith(body: string, images: Record<string, Uint8Array>) {
    const directory = await folder(images);
    const draft = join(directory, "report.html");
    await prepareArtifactDraft({
      path: draft,
      title: "Report",
      cwd: directory,
      configHome: join(directory, "config"),
      stylePath: "",
    });
    const source = await readFile(draft, "utf8");
    await writeFile(draft, source.replace("</main>", `${body}</main>`));
    return { directory, draft };
  }

  test("embeds small images and lists the files to upload", async () => {
    const { directory, draft } = await draftWith(
      '<img src="images/chart.png" alt="Chart"><img src="images/icon.png" alt="">',
      { "chart.png": largePng(), "icon.png": pngBytes() },
    );

    const finalized = await finalizeArtifact({
      path: draft,
      cwd: directory,
      configHome: join(directory, "config"),
      stylePath: "",
    });

    const html = await readFile(finalized.path, "utf8");
    expect(finalized.imageFiles).toEqual(["chart.png"]);
    expect(html).toContain('src="images/chart.png"');
    expect(html).not.toContain("images/icon.png");
  });

  test("refuses to write the output away from the images it loads", async () => {
    const { directory, draft } = await draftWith('<img src="images/chart.png" alt="Chart">', {
      "chart.png": largePng(),
    });

    await expect(
      finalizeArtifact({
        path: draft,
        outputPath: join(directory, "elsewhere", "report.html"),
        cwd: directory,
        configHome: join(directory, "config"),
        stylePath: "",
      }),
    ).rejects.toThrow("next to the draft's images/ folder");
  });
});
