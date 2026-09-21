import { type DefaultTreeAdapterTypes, parse } from "parse5";

type Element = DefaultTreeAdapterTypes.Element;
type ChildNode = DefaultTreeAdapterTypes.ChildNode;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;
type TextNode = DefaultTreeAdapterTypes.TextNode;

/**
 * Bump when the output of a conversion changes. A stored conversion made by an
 * older converter is regenerated rather than served.
 */
export const CONVERTER_VERSION = "1";

export type Conversion = {
  markdown: string;
  /** True when the document carries no static text worth reading. */
  empty: boolean;
};

/**
 * Elements dropped with everything inside them. Scripts and styles are not
 * content; the embedded and interactive elements have nothing to say in a text
 * rendering, and their attributes can carry URLs a reader should not follow.
 */
const DROPPED = new Set([
  "script",
  "style",
  "template",
  "noscript",
  "svg",
  "math",
  "iframe",
  "object",
  "embed",
  "canvas",
  "video",
  "audio",
  "form",
  "input",
  "button",
  "select",
  "option",
  "textarea",
  "head",
  "link",
  "meta",
  "base",
]);

/** Elements that hold blocks and contribute nothing themselves. */
const CONTAINERS = new Set([
  "html",
  "body",
  "div",
  "main",
  "section",
  "article",
  "header",
  "footer",
  "aside",
  "nav",
  "figure",
  "details",
  "summary",
  "span",
  "label",
  "picture",
  "fieldset",
  "dl",
]);

const HEADINGS: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

const SAFE_LINK_SCHEMES = new Set(["http:", "https:", "mailto:"]);
const SAFE_IMAGE_SCHEMES = new Set(["http:", "https:"]);

function isElement(node: ChildNode): node is Element {
  return "tagName" in node;
}

function isText(node: ChildNode): node is TextNode {
  return node.nodeName === "#text";
}

function childrenOf(node: ParentNode | Element): ChildNode[] {
  return node.childNodes ?? [];
}

function attribute(element: Element, name: string): string | undefined {
  return element.attrs?.find((attr: { name: string }) => attr.name === name)?.value;
}

/**
 * Keeps a URL only when its scheme is one a reader can follow safely. A
 * `javascript:` or `data:` URL never reaches the output, and a relative URL
 * from a self-contained document points nowhere useful, so it is dropped too.
 */
export function safeUrl(value: string | undefined, schemes: Set<string>): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (!schemes.has(url.protocol)) return null;
  // Whitespace, a parenthesis, or an angle bracket would break the link
  // syntax, and Markdown has no escape for one inside a destination.
  if (/[\s()<>]/.test(trimmed)) return null;
  return trimmed;
}

const ESCAPED = /([\\`*_[\]<>|~])/g;

function escapeText(text: string): string {
  return text.replace(ESCAPED, "\\$1");
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ");
}

function renderInline(nodes: ChildNode[]): string {
  let out = "";
  for (const node of nodes) {
    if (isText(node)) {
      out += escapeText(collapse(node.value));
      continue;
    }
    if (!isElement(node)) continue;
    const tag = node.nodeName;
    if (DROPPED.has(tag)) continue;

    switch (tag) {
      case "br":
        out += "\n";
        break;
      case "strong":
      case "b": {
        const inner = renderInline(childrenOf(node)).trim();
        out += inner === "" ? "" : `**${inner}**`;
        break;
      }
      case "em":
      case "i": {
        const inner = renderInline(childrenOf(node)).trim();
        out += inner === "" ? "" : `*${inner}*`;
        break;
      }
      case "del":
      case "s": {
        const inner = renderInline(childrenOf(node)).trim();
        out += inner === "" ? "" : `~~${inner}~~`;
        break;
      }
      case "code": {
        const inner = collapse(textOf(node)).trim();
        out += inner === "" ? "" : `\`${inner}\``;
        break;
      }
      case "a": {
        const inner = renderInline(childrenOf(node)).trim();
        const href = safeUrl(attribute(node, "href"), SAFE_LINK_SCHEMES);
        // A link nobody should follow still keeps its text.
        out += href ? `[${inner === "" ? href : inner}](${href})` : inner;
        break;
      }
      case "img": {
        const alt = collapse(attribute(node, "alt") ?? "").trim();
        const src = safeUrl(attribute(node, "src"), SAFE_IMAGE_SCHEMES);
        // An inline image is data, not text. Without a followable source only
        // its description survives.
        if (src) out += `![${escapeText(alt)}](${src})`;
        else if (alt !== "") out += escapeText(alt);
        break;
      }
      default:
        out += renderInline(childrenOf(node));
    }
  }
  return out;
}

function textOf(node: Element): string {
  let out = "";
  for (const child of childrenOf(node)) {
    if (isText(child)) out += child.value;
    else if (isElement(child) && !DROPPED.has(child.nodeName)) out += textOf(child);
  }
  return out;
}

function renderListItem(item: Element, marker: string, depth: number): string[] {
  const indent = "  ".repeat(depth);
  const inline: ChildNode[] = [];
  const nested: Element[] = [];
  for (const child of childrenOf(item)) {
    if (isElement(child) && (child.nodeName === "ul" || child.nodeName === "ol"))
      nested.push(child);
    else inline.push(child);
  }

  const text = renderInline(inline).trim();
  const lines = [`${indent}${marker} ${text}`.trimEnd()];
  for (const list of nested) lines.push(...renderList(list, depth + 1));
  return lines;
}

function renderList(list: Element, depth: number): string[] {
  const ordered = list.nodeName === "ol";
  const lines: string[] = [];
  let index = 1;
  for (const child of childrenOf(list)) {
    if (!isElement(child) || child.nodeName !== "li") continue;
    lines.push(...renderListItem(child, ordered ? `${index}.` : "-", depth));
    index += 1;
  }
  return lines;
}

function cellsOf(row: Element): string[] {
  return childrenOf(row)
    .filter(
      (cell): cell is Element =>
        isElement(cell) && (cell.nodeName === "td" || cell.nodeName === "th"),
    )
    .map((cell) => renderInline(childrenOf(cell)).trim().replace(/\|/g, "\\|") || " ");
}

function renderTable(table: Element): string | null {
  const rows: Element[] = [];
  const collect = (node: Element) => {
    for (const child of childrenOf(node)) {
      if (!isElement(child)) continue;
      if (child.nodeName === "tr") rows.push(child);
      else if (["thead", "tbody", "tfoot"].includes(child.nodeName)) collect(child);
    }
  };
  collect(table);
  if (rows.length === 0) return null;

  const [head, ...body] = rows;
  if (!head) return null;
  const headCells = cellsOf(head);
  const width = Math.max(headCells.length, ...body.map((row) => cellsOf(row).length));
  const pad = (cells: string[]) =>
    `| ${Array.from({ length: width }, (_, index) => cells[index] ?? " ").join(" | ")} |`;

  return [
    pad(headCells),
    `| ${Array.from({ length: width }, () => "---").join(" | ")} |`,
    ...body.map((row) => pad(cellsOf(row))),
  ].join("\n");
}

function renderBlocks(nodes: ChildNode[]): string[] {
  const blocks: string[] = [];

  for (const node of nodes) {
    if (isText(node)) {
      const text = escapeText(collapse(node.value)).trim();
      if (text !== "") blocks.push(text);
      continue;
    }
    if (!isElement(node)) continue;

    const tag = node.nodeName;
    if (DROPPED.has(tag)) continue;

    const heading = HEADINGS[tag];
    if (heading) {
      const text = renderInline(childrenOf(node)).trim();
      if (text !== "") blocks.push(`${"#".repeat(heading)} ${text}`);
      continue;
    }

    switch (tag) {
      case "p":
      case "dd":
      case "dt":
      case "figcaption": {
        const text = renderInline(childrenOf(node)).trim();
        if (text !== "") blocks.push(text);
        break;
      }
      case "ul":
      case "ol": {
        const lines = renderList(node, 0);
        if (lines.length > 0) blocks.push(lines.join("\n"));
        break;
      }
      case "pre": {
        const code = textOf(node).replace(/\n+$/, "");
        if (code.trim() !== "") blocks.push(`\`\`\`\n${code}\n\`\`\``);
        break;
      }
      case "blockquote": {
        const inner = renderBlocks(childrenOf(node));
        if (inner.length > 0) {
          blocks.push(
            inner
              .join("\n\n")
              .split("\n")
              .map((line) => (line === "" ? ">" : `> ${line}`))
              .join("\n"),
          );
        }
        break;
      }
      case "table": {
        const table = renderTable(node);
        if (table) blocks.push(table);
        break;
      }
      case "hr":
        blocks.push("---");
        break;
      default:
        if (CONTAINERS.has(tag)) blocks.push(...renderBlocks(childrenOf(node)));
        else {
          const text = renderInline([node]).trim();
          if (text !== "") blocks.push(text);
        }
    }
  }

  return blocks;
}

/**
 * Converts stored HTML to Markdown.
 *
 * The document is parsed, never executed: parse5 builds a tree and nothing
 * else happens. Only known elements reach the output, so anything unexpected
 * is dropped rather than passed through.
 */
export function htmlToMarkdown(html: string): Conversion {
  const document = parse(html);
  const blocks = renderBlocks(document.childNodes as ChildNode[]);
  const markdown = blocks
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { markdown, empty: markdown === "" };
}
