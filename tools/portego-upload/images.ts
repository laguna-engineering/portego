import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type DefaultTreeAdapterTypes, parse } from "parse5";
import {
  DEFAULT_MAX_IMAGE_BYTES_TOTAL,
  DEFAULT_MAX_IMAGES,
  detectImageType,
  IMAGE_MAX_BYTES,
  isImageName,
  nameMatchesType,
} from "../../src/server/artifacts/images.ts";
import type { ValidationIssue } from "./style.ts";

type ChildNode = DefaultTreeAdapterTypes.ChildNode;
type Element = DefaultTreeAdapterTypes.Element;

/** Images up to this size are embedded as data URIs. Larger ones are uploaded as files. */
export const INLINE_IMAGE_MAX_BYTES = 16 * 1024;

export type ImageLimits = { maxImages: number; maxImageBytesTotal: number };

export const DEFAULT_IMAGE_LIMITS: ImageLimits = {
  maxImages: DEFAULT_MAX_IMAGES,
  maxImageBytesTotal: DEFAULT_MAX_IMAGE_BYTES_TOTAL,
};

export type ImageFile = { name: string; bytes: Buffer };

export type ResolvedImages = {
  /** The document with every small image embedded. */
  html: string;
  /** Images the document still loads as images/<name>, to upload with it. */
  files: ImageFile[];
  issues: ValidationIssue[];
};

const IMAGE_PREFIX = "images/";

/** The name in an images/<name> reference, or null for any other URL. */
export function imageReference(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.startsWith(IMAGE_PREFIX) ? trimmed.slice(IMAGE_PREFIX.length) : null;
}

export function isImageFileReference(value: string): boolean {
  const name = imageReference(value);
  return name !== null && isImageName(name);
}

/** Every url(...) in a piece of CSS, with the exact text that wrote it. */
export function cssUrls(css: string): { whole: string; value: string }[] {
  const matches: { whole: string; value: string }[] = [];
  const expression = /url\(\s*(?:(["'])(.*?)\1|([^)]*?))\s*\)/gi;
  for (const match of css.matchAll(expression)) {
    const value = (match[2] ?? match[3] ?? "").trim();
    matches.push({ whole: match[0], value });
  }
  return matches;
}

type Decision = { dataUrl: string } | { file: ImageFile } | { issue: ValidationIssue };

function isSvg(name: string, bytes: Buffer): boolean {
  return name.toLowerCase().endsWith(".svg") && /<svg[\s>]/i.test(bytes.toString("utf8"));
}

/**
 * Reads images/<name> next to the document. The name is checked first, so it
 * is one path segment and cannot leave that folder. A symlink is refused, so
 * the folder cannot point the upload at a file somewhere else on this machine.
 */
async function decide(baseDir: string, name: string): Promise<Decision> {
  const reference = `${IMAGE_PREFIX}${name}`;
  const error = (code: string, message: string): Decision => ({
    issue: { level: "error", code, message: `${reference}: ${message}` },
  });
  if (!isImageName(name)) {
    return error(
      "image-name",
      "an image name is 1 to 100 letters, digits, dots, dashes, or underscores, starting with a letter or digit.",
    );
  }
  const path = join(baseDir, "images", name);
  let size: number;
  try {
    const stats = await lstat(path);
    if (!stats.isFile()) return error("image-file", `${path} is not a regular file.`);
    size = stats.size;
  } catch {
    return error("image-missing", `${path} does not exist.`);
  }
  if (size > IMAGE_MAX_BYTES) {
    return error("image-size", `${size} bytes is over the ${IMAGE_MAX_BYTES} byte limit.`);
  }
  const bytes = await readFile(path);

  // SVG can carry script, so the server refuses it as a file. As a data URI
  // in an image it renders without running anything.
  if (isSvg(name, bytes)) {
    return { dataUrl: `data:image/svg+xml;base64,${bytes.toString("base64")}` };
  }
  const type = detectImageType(bytes);
  if (!type) return error("image-type", "not a PNG, JPEG, GIF, WebP, AVIF, or SVG file.");
  if (!nameMatchesType(name, type)) {
    return error(
      "image-type",
      `holds ${type.contentType} data; its name must end in .${type.extension}.`,
    );
  }
  if (bytes.byteLength <= INLINE_IMAGE_MAX_BYTES) {
    return { dataUrl: `data:${type.contentType};base64,${bytes.toString("base64")}` };
  }
  return { file: { name, bytes } };
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

/**
 * Finds every images/<name> the document loads from an <img> src or a CSS
 * url(), embeds the small ones, and returns the rest as files to upload. The
 * document is edited at the parser's source offsets, so nothing else in it
 * changes.
 */
export async function resolveLocalImages(html: string, baseDir: string): Promise<ResolvedImages> {
  const document = parse(html, { sourceCodeLocationInfo: true });
  const decisions = new Map<string, Decision>();
  const pending: { start: number; end: number; build: () => string | null }[] = [];
  const names = new Set<string>();

  const note = (value: string) => {
    const name = imageReference(value);
    if (name !== null) names.add(name);
    return name;
  };
  const inlineCss = (css: string): string | null => {
    let changed = css;
    for (const match of cssUrls(css)) {
      const name = imageReference(match.value);
      const decision = name === null ? undefined : decisions.get(name);
      if (decision && "dataUrl" in decision) {
        // A base64 data URI holds no quote, space, or parenthesis, so it
        // needs no quoting inside url().
        changed = changed.replaceAll(match.whole, `url(${decision.dataUrl})`);
      }
    }
    return changed === css ? null : changed;
  };

  const visit = (node: ChildNode) => {
    if (!("tagName" in node)) {
      if ("childNodes" in node && Array.isArray(node.childNodes)) {
        for (const child of node.childNodes as ChildNode[]) visit(child);
      }
      return;
    }
    const element: Element = node;
    const location = element.sourceCodeLocation;
    for (const attribute of element.attrs) {
      const span = location?.attrs?.[attribute.name];
      if (!span) continue;
      if (element.tagName === "img" && attribute.name === "src") {
        const name = note(attribute.value);
        if (name === null) continue;
        pending.push({
          start: span.startOffset,
          end: span.endOffset,
          build: () => {
            const decision = decisions.get(name);
            return decision && "dataUrl" in decision ? `src="${decision.dataUrl}"` : null;
          },
        });
      }
      if (attribute.name === "style") {
        for (const match of cssUrls(attribute.value)) note(match.value);
        pending.push({
          start: span.startOffset,
          end: span.endOffset,
          build: () => {
            const css = inlineCss(attribute.value);
            return css === null ? null : `style="${escapeAttribute(css)}"`;
          },
        });
      }
    }
    if (element.tagName === "style") {
      const text = element.childNodes[0];
      const span = text?.sourceCodeLocation;
      if (text && "value" in text && span) {
        for (const match of cssUrls(text.value)) note(match.value);
        pending.push({
          start: span.startOffset,
          end: span.endOffset,
          build: () => inlineCss(text.value),
        });
      }
    }
    for (const child of element.childNodes) visit(child);
  };
  for (const child of document.childNodes) visit(child);

  for (const name of [...names].sort()) decisions.set(name, await decide(baseDir, name));

  let result = html;
  for (const edit of pending.sort((a, b) => b.start - a.start)) {
    const replacement = edit.build();
    if (replacement !== null)
      result = result.slice(0, edit.start) + replacement + result.slice(edit.end);
  }

  const files: ImageFile[] = [];
  const issues: ValidationIssue[] = [];
  for (const decision of decisions.values()) {
    if ("file" in decision) files.push(decision.file);
    if ("issue" in decision) issues.push(decision.issue);
  }
  return { html: result, files, issues };
}

/** The limits one upload is held to, checked before any bytes are sent. */
export function checkImageLimits(files: ImageFile[], limits: ImageLimits): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (files.length > limits.maxImages) {
    issues.push({
      level: "error",
      code: "image-count",
      message: `The document loads ${files.length} image files and one upload carries at most ${limits.maxImages}.`,
    });
  }
  const total = files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  if (total > limits.maxImageBytesTotal) {
    issues.push({
      level: "error",
      code: "image-total-size",
      message: `The image files total ${total} bytes and one upload carries at most ${limits.maxImageBytesTotal}.`,
    });
  }
  return issues;
}
