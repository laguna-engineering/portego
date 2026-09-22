import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type DefaultTreeAdapterTypes, parse } from "parse5";
import { z } from "zod";

type ChildNode = DefaultTreeAdapterTypes.ChildNode;
type Element = DefaultTreeAdapterTypes.Element;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;

type StyleSource = "explicit" | "project" | "user" | "bundled";
type StyleFile = { path: string; root: string };
type Template = { path: string; description: string };

export type ArtifactStyle = {
  name: string;
  source: StyleSource;
  root: string;
  /** Changes whenever the files that define this resolved style change. */
  digest: string;
  instructionFiles: string[];
  styleFiles: StyleFile[];
  templates: Record<string, Template>;
};

export type StyleSummary = {
  name: string;
  source: StyleSource;
  root: string;
  instructions: string;
  styleFiles: string[];
  templates: { name: string; description: string; path: string }[];
};

export type ValidationIssue = {
  level: "error" | "warning";
  code: string;
  message: string;
};

export type ValidationResult = {
  valid: boolean;
  byteSize: number;
  issues: ValidationIssue[];
};

export class ArtifactStyleError extends Error {}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

const relativeFile = z
  .string()
  .min(1)
  .refine(
    (value) => !isAbsolute(value) && !value.split(/[\\/]/).includes("..") && !value.startsWith("~"),
    "must be a relative path contained by the style directory",
  );

const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().min(1).max(100),
  extends: z.literal("portego").optional(),
  instructions: relativeFile.optional(),
  styles: z.array(relativeFile).default([]),
  templates: z
    .record(
      z.string().min(1),
      z.object({
        path: relativeFile,
        description: z.string().min(1).max(300),
      }),
    )
    .default({}),
});

type Manifest = z.infer<typeof manifestSchema>;

function moduleDirectory(): string {
  return dirname(fileURLToPath(import.meta.url));
}

function bundledStyleRoot(): string {
  const here = moduleDirectory();
  const candidates = [join(here, "style", "portego"), join(here, "..", "style", "portego")];
  const root = candidates.find((candidate) => existsSync(join(candidate, "manifest.json")));
  if (!root) {
    throw new ArtifactStyleError("The bundled Portego artifact style is missing.");
  }
  return root;
}

function styleRoot(path: string): string {
  return basename(path) === "manifest.json" ? dirname(path) : path;
}

function findProjectStyle(start: string): string | null {
  let directory = resolve(start);
  while (true) {
    const candidate = join(directory, ".portego", "artifact-style");
    if (existsSync(join(candidate, "manifest.json"))) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function assertContained(root: string, path: string): void {
  let canonicalRoot: string;
  let canonicalPath: string;
  try {
    canonicalRoot = realpathSync(root);
    canonicalPath = realpathSync(path);
  } catch (error) {
    throw new ArtifactStyleError(`Cannot resolve style file ${path}: ${(error as Error).message}`);
  }
  const fromRoot = relative(canonicalRoot, canonicalPath);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new ArtifactStyleError(`${path} is outside the style directory ${root}.`);
  }
}

async function readManifest(root: string): Promise<Manifest> {
  const path = join(root, "manifest.json");
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new ArtifactStyleError(`Cannot read ${path}: ${(error as Error).message}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new ArtifactStyleError(`${path} is not valid JSON: ${(error as Error).message}`);
  }

  const result = manifestSchema.safeParse(value);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`)
      .join("; ");
    throw new ArtifactStyleError(`Invalid artifact style manifest ${path}: ${details}`);
  }
  return result.data;
}

function requiredFile(root: string, path: string): string {
  const absolute = resolve(root, path);
  if (!existsSync(absolute)) {
    throw new ArtifactStyleError(`The artifact style references a missing file: ${absolute}`);
  }
  assertContained(root, absolute);
  return absolute;
}

async function styleDigest(style: Omit<ArtifactStyle, "digest">): Promise<string> {
  const hash = createHash("sha256");
  const files = [
    ...style.instructionFiles,
    ...style.styleFiles.map((file) => file.path),
    ...Object.values(style.templates).map((template) => template.path),
  ].sort();
  for (const path of files) {
    hash.update(path);
    hash.update(await readFile(path));
  }
  return hash.digest("hex");
}

async function loadStyle(root: string, source: StyleSource): Promise<ArtifactStyle> {
  const manifest = await readManifest(root);
  let base: ArtifactStyle | null = null;
  if (manifest.extends === "portego") {
    const defaultRoot = bundledStyleRoot();
    if (resolve(root) === resolve(defaultRoot)) {
      throw new ArtifactStyleError("The bundled Portego style cannot extend itself.");
    }
    base = await loadStyle(defaultRoot, "bundled");
  }

  const instructionFiles = [...(base?.instructionFiles ?? [])];
  if (manifest.instructions) instructionFiles.push(requiredFile(root, manifest.instructions));

  const styleFiles = [...(base?.styleFiles ?? [])];
  for (const path of manifest.styles) {
    styleFiles.push({ path: requiredFile(root, path), root });
  }

  const templates = { ...(base?.templates ?? {}) };
  for (const [name, template] of Object.entries(manifest.templates)) {
    templates[name] = {
      path: requiredFile(root, template.path),
      description: template.description,
    };
  }

  if (styleFiles.length === 0) {
    throw new ArtifactStyleError(`${join(root, "manifest.json")} defines no styles.`);
  }
  if (Object.keys(templates).length === 0) {
    throw new ArtifactStyleError(`${join(root, "manifest.json")} defines no templates.`);
  }

  const style = {
    name: manifest.name,
    source,
    root,
    instructionFiles,
    styleFiles,
    templates,
  };
  return { ...style, digest: await styleDigest(style) };
}

export async function resolveArtifactStyle(
  options: { stylePath?: string; cwd?: string; configHome?: string } = {},
): Promise<ArtifactStyle> {
  const explicit = options.stylePath?.trim() || process.env.PORTEGO_ARTIFACT_STYLE?.trim();
  if (explicit) {
    const root = resolve(styleRoot(explicit));
    return loadStyle(root, "explicit");
  }

  const project = findProjectStyle(options.cwd ?? process.cwd());
  if (project) return loadStyle(project, "project");

  const configHome =
    options.configHome ?? process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  const user = join(configHome, "portego", "artifact-style");
  if (existsSync(join(user, "manifest.json"))) return loadStyle(user, "user");

  return loadStyle(bundledStyleRoot(), "bundled");
}

export async function summarizeArtifactStyle(style: ArtifactStyle): Promise<StyleSummary> {
  const instructions = await Promise.all(
    style.instructionFiles.map(async (path) => {
      const text = await readFile(path, "utf8");
      return `# ${basename(dirname(path)) === "portego" ? "Portego" : basename(dirname(path))}\n\n${text.trim()}`;
    }),
  );
  return {
    name: style.name,
    source: style.source,
    root: style.root,
    instructions: instructions.join("\n\n").trim(),
    styleFiles: style.styleFiles.map((file) => file.path),
    templates: Object.entries(style.templates)
      .map(([name, template]) => ({ name, ...template }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export async function prepareArtifactDraft(options: {
  path: string;
  title: string;
  template?: string;
  stylePath?: string;
  overwrite?: boolean;
  cwd?: string;
  configHome?: string;
}): Promise<{ path: string; style: string; template: string }> {
  if (!isAbsolute(options.path)) {
    throw new ArtifactStyleError("The artifact draft path must be absolute.");
  }
  if (existsSync(options.path) && !options.overwrite) {
    throw new ArtifactStyleError(`${options.path} already exists. Choose another path.`);
  }

  const style = await resolveArtifactStyle(options);
  const templateName = options.template ?? "report";
  const template = style.templates[templateName];
  if (!template) {
    throw new ArtifactStyleError(
      `Style ${style.name} has no ${templateName} template. Available templates: ${Object.keys(style.templates).join(", ")}.`,
    );
  }

  const source = await readFile(template.path, "utf8");
  const draft = source
    .replaceAll("{{TITLE}}", escapeHtml(options.title))
    .replaceAll("{{STYLE_NAME}}", escapeHtml(style.name))
    .replace(
      /<style(?=[^>]*\bdata-portego-style\b)[^>]*>\s*<\/style>/i,
      `<style data-portego-style="${escapeHtml(style.name)}" data-portego-style-digest="${style.digest}"></style>`,
    );
  await mkdir(dirname(options.path), { recursive: true });
  await writeFile(options.path, draft);
  return { path: options.path, style: style.name, template: templateName };
}

const bundledFonts: Record<string, { family: string; filename: string }> = {
  "assets/fonts/ibm-plex-serif-latin-400-normal.woff2": {
    family: "ibm-plex-serif",
    filename: "ibm-plex-serif-latin-400-normal.woff2",
  },
  "assets/fonts/ibm-plex-serif-latin-500-normal.woff2": {
    family: "ibm-plex-serif",
    filename: "ibm-plex-serif-latin-500-normal.woff2",
  },
  "assets/fonts/ibm-plex-sans-latin-400-normal.woff2": {
    family: "ibm-plex-sans",
    filename: "ibm-plex-sans-latin-400-normal.woff2",
  },
  "assets/fonts/ibm-plex-sans-latin-600-normal.woff2": {
    family: "ibm-plex-sans",
    filename: "ibm-plex-sans-latin-600-normal.woff2",
  },
  "assets/fonts/ibm-plex-mono-latin-400-normal.woff2": {
    family: "ibm-plex-mono",
    filename: "ibm-plex-mono-latin-400-normal.woff2",
  },
};

const mimeTypes: Record<string, string> = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function cssUrls(css: string): { whole: string; value: string }[] {
  const matches: { whole: string; value: string }[] = [];
  const expression = /url\(\s*(?:(["'])(.*?)\1|([^)]*?))\s*\)/gi;
  for (const match of css.matchAll(expression)) {
    const value = (match[2] ?? match[3] ?? "").trim();
    matches.push({ whole: match[0], value });
  }
  return matches;
}

function bundledFontFallback(file: StyleFile, asset: string): string | null {
  if (resolve(file.root) !== resolve(bundledStyleRoot())) return null;
  const font = bundledFonts[relative(file.root, asset).replaceAll("\\", "/")];
  if (!font) return null;
  const path = join(
    moduleDirectory(),
    "..",
    "..",
    "node_modules",
    "@fontsource",
    font.family,
    "files",
    font.filename,
  );
  return existsSync(path) ? path : null;
}

async function inlineCssAssets(file: StyleFile): Promise<string> {
  let css = await readFile(file.path, "utf8");
  if (/@import\b/i.test(css)) {
    throw new ArtifactStyleError(
      `${file.path} uses @import. List every CSS file in manifest.json.`,
    );
  }
  if (/<\/style/i.test(css)) {
    throw new ArtifactStyleError(`${file.path} contains </style and cannot be embedded safely.`);
  }

  for (const match of cssUrls(css)) {
    if (/^(data:|blob:|#)/i.test(match.value)) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(match.value) || match.value.startsWith("//")) {
      throw new ArtifactStyleError(
        `${file.path} references ${match.value}. Artifact styles cannot load network resources.`,
      );
    }
    const asset = resolve(dirname(file.path), match.value);
    const fallback = existsSync(asset) ? null : bundledFontFallback(file, asset);
    if (!fallback) assertContained(file.root, asset);
    let bytes: Buffer;
    try {
      bytes = await readFile(fallback ?? asset);
    } catch (error) {
      throw new ArtifactStyleError(`Cannot read style asset ${asset}: ${(error as Error).message}`);
    }
    const mime = mimeTypes[extname(asset).toLowerCase()] ?? "application/octet-stream";
    css = css.replace(match.whole, `url("data:${mime};base64,${bytes.toString("base64")}")`);
  }
  return css.trim();
}

function defaultFinalPath(path: string): string {
  const extension = extname(path);
  const stem = extension ? basename(path, extension) : basename(path);
  return join(dirname(path), `${stem}.portego.html`);
}

export async function finalizeArtifact(options: {
  path: string;
  outputPath?: string;
  stylePath?: string;
  /** Permit finalizing a prepared draft with a different style. */
  allowStyleChange?: boolean;
  maxBytes?: number;
  cwd?: string;
  configHome?: string;
}): Promise<{
  path: string;
  style: string;
  byteSize: number;
  warnings: ValidationIssue[];
}> {
  if (!isAbsolute(options.path)) {
    throw new ArtifactStyleError("The artifact draft path must be absolute.");
  }
  const outputPath = options.outputPath ?? defaultFinalPath(options.path);
  if (!isAbsolute(outputPath)) {
    throw new ArtifactStyleError("The finalized artifact path must be absolute.");
  }

  const style = await resolveArtifactStyle(options);
  const source = await readFile(options.path, "utf8");
  const preparedDigest = source.match(/\bdata-portego-style-digest="([a-f0-9]{64})"/i)?.[1];
  if (preparedDigest && preparedDigest !== style.digest && !options.allowStyleChange) {
    throw new ArtifactStyleError(
      "The draft was prepared with a different style. Pass allowStyleChange to replace it.",
    );
  }
  const parts = await Promise.all(style.styleFiles.map(inlineCssAssets));
  const css = parts.join("\n\n");
  const styleTag = `<style data-portego-style="${escapeHtml(style.name)}" data-portego-style-digest="${style.digest}">\n${css}\n</style>`;
  const marker = /<style(?=[^>]*\bdata-portego-style\b)[^>]*>[\s\S]*?<\/style>/i;
  let html: string;
  if (marker.test(source)) {
    html = source.replace(marker, styleTag);
  } else if (/<\/head>/i.test(source)) {
    html = source.replace(/<\/head>/i, `${styleTag}\n</head>`);
  } else {
    throw new ArtifactStyleError(
      `${options.path} has neither a data-portego-style marker nor a closing </head>.`,
    );
  }

  const validation = validateArtifactHtml(html, options.maxBytes);
  const errors = validation.issues.filter((issue) => issue.level === "error");
  if (errors.length > 0) {
    throw new ArtifactStyleError(
      `The finalized artifact is invalid:\n${errors.map((issue) => `- ${issue.message}`).join("\n")}`,
    );
  }

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, html);
  return {
    path: outputPath,
    style: style.name,
    byteSize: validation.byteSize,
    warnings: validation.issues.filter((issue) => issue.level === "warning"),
  };
}

function isElement(node: ChildNode): node is Element {
  return "tagName" in node;
}

function hasChildren(node: ChildNode): node is ChildNode & { childNodes: ChildNode[] } {
  return "childNodes" in node && Array.isArray(node.childNodes);
}

function attributes(element: Element): Record<string, string> {
  return Object.fromEntries(element.attrs.map((attribute) => [attribute.name, attribute.value]));
}

function textContent(node: ParentNode): string {
  return node.childNodes
    .map((child) =>
      "value" in child ? child.value : "childNodes" in child ? textContent(child) : "",
    )
    .join("");
}

function resourceIsInline(value: string): boolean {
  return /^(data:|blob:|#)/i.test(value.trim());
}

const resourceAttributes: Record<string, string[]> = {
  audio: ["src"],
  embed: ["src"],
  iframe: ["src"],
  img: ["src", "srcset"],
  input: ["src"],
  link: ["href"],
  object: ["data"],
  script: ["src"],
  source: ["src", "srcset"],
  track: ["src"],
  video: ["src", "poster"],
};

function inspectCss(css: string, add: (issue: ValidationIssue) => void): void {
  if (/@import\b/i.test(css)) {
    add({ level: "error", code: "css-import", message: "CSS @import is not self-contained." });
  }
  for (const { value } of cssUrls(css)) {
    if (!resourceIsInline(value)) {
      add({
        level: "error",
        code: "css-resource",
        message: `CSS resource ${value || "(empty)"} is not an inline data or blob URL.`,
      });
    }
  }
}

export function validateArtifactHtml(html: string, maxBytes = DEFAULT_MAX_BYTES): ValidationResult {
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  const add = (issue: ValidationIssue) => {
    const key = `${issue.level}:${issue.code}:${issue.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      issues.push(issue);
    }
  };

  const document = parse(html, {
    onParseError(error) {
      add({
        level: "warning",
        code: "html-parse",
        message: `HTML parser warning ${error.code} at line ${error.startLine ?? "?"}.`,
      });
    },
  });

  const byteSize = Buffer.byteLength(html);
  if (byteSize > maxBytes) {
    add({
      level: "error",
      code: "file-size",
      message: `The artifact is ${byteSize} bytes and the configured limit is ${maxBytes}.`,
    });
  }

  let hasDoctype = false;
  let hasTitle = false;
  let hasViewport = false;
  let hasLanguage = false;
  let hasHeading = false;

  const visit = (node: ChildNode) => {
    if (node.nodeName === "#documentType") hasDoctype = true;
    if (!isElement(node)) {
      if (hasChildren(node)) for (const child of node.childNodes) visit(child);
      return;
    }

    const attrs = attributes(node);
    if (node.tagName === "html" && attrs.lang?.trim()) hasLanguage = true;
    if (node.tagName === "title" && textContent(node).trim()) hasTitle = true;
    if (/^h[1-6]$/.test(node.tagName)) hasHeading = true;
    if (
      node.tagName === "meta" &&
      attrs.name?.toLowerCase() === "viewport" &&
      attrs.content?.trim()
    ) {
      hasViewport = true;
    }
    if (node.tagName === "meta" && attrs["http-equiv"]?.toLowerCase() === "refresh") {
      add({
        level: "error",
        code: "meta-refresh",
        message: "Meta refresh can navigate away from the artifact and is not allowed.",
      });
    }
    if (node.tagName === "base") {
      add({
        level: "error",
        code: "base-element",
        message: "A base element changes URL resolution and is not allowed.",
      });
    }
    if (["iframe", "object", "embed"].includes(node.tagName)) {
      add({
        level: "error",
        code: "blocked-embed",
        message: `<${node.tagName}> cannot render under Portego's artifact policy.`,
      });
    }
    if (node.tagName === "form" && attrs.action) {
      add({
        level: "error",
        code: "form-action",
        message: "A form action requires navigation or network access and is not allowed.",
      });
    }
    if (node.tagName === "img" && !("alt" in attrs)) {
      add({
        level: "warning",
        code: "image-alt",
        message: 'Every image should have an alt attribute. Use alt="" for decorative images.',
      });
    }

    for (const attribute of resourceAttributes[node.tagName] ?? []) {
      const value = attrs[attribute];
      if (value !== undefined && !resourceIsInline(value)) {
        add({
          level: "error",
          code: "external-resource",
          message: `<${node.tagName}> ${attribute}=${JSON.stringify(value)} is not self-contained.`,
        });
      }
    }

    if (node.tagName === "style") inspectCss(textContent(node), add);
    if (attrs.style) inspectCss(attrs.style, add);
    if (node.tagName === "script") {
      const script = textContent(node);
      if (
        /\b(fetch|WebSocket|EventSource)\s*\(|\bXMLHttpRequest\b|\.sendBeacon\s*\(/.test(script)
      ) {
        add({
          level: "error",
          code: "script-network",
          message: "An inline script attempts network access, which Portego blocks.",
        });
      }
    }

    for (const child of node.childNodes) visit(child);
  };

  for (const child of document.childNodes) visit(child);
  if (!hasDoctype) {
    add({ level: "warning", code: "doctype", message: "Add <!doctype html>." });
  }
  if (!hasTitle) {
    add({ level: "error", code: "title", message: "Add a non-empty <title>." });
  }
  if (!hasViewport) {
    add({
      level: "warning",
      code: "viewport",
      message: 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.',
    });
  }
  if (!hasLanguage) {
    add({ level: "warning", code: "language", message: "Add a lang attribute to <html>." });
  }
  if (!hasHeading) {
    add({ level: "warning", code: "heading", message: "Add at least one heading." });
  }

  return {
    valid: !issues.some((issue) => issue.level === "error"),
    byteSize,
    issues,
  };
}

export async function validateArtifactFile(
  path: string,
  maxBytes = DEFAULT_MAX_BYTES,
): Promise<ValidationResult> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    throw new ArtifactStyleError(`Cannot read ${path}: ${(error as Error).message}`);
  }
  let html: string;
  try {
    html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ArtifactStyleError(`${path} is not valid UTF-8.`);
  }
  return validateArtifactHtml(html, maxBytes);
}
