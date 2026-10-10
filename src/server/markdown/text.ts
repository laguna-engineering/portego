import { marked, type Token, type Tokens } from "marked";

/** Bump when the output of markdownToText changes, so indexed versions are reindexed. */
export const TEXT_VERSION = "1";

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

const INLINE = new Set(["text", "link", "strong", "em", "del"]);

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (entity, name: string) => {
    if (name.startsWith("#")) {
      const code =
        name[1] === "x" || name[1] === "X"
          ? Number.parseInt(name.slice(2), 16)
          : Number(name.slice(1));
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : entity;
    }
    return ENTITIES[name.toLowerCase()] ?? entity;
  });
}

function collect(tokens: Token[], parts: string[]): void {
  for (const token of tokens) {
    switch (token.type) {
      case "html":
        break;
      case "table": {
        const table = token as Tokens.Table;
        for (const row of [table.header, ...table.rows]) {
          for (const cell of row) {
            collect(cell.tokens, parts);
            parts.push(" ");
          }
          parts.push("\n");
        }
        break;
      }
      case "list":
        for (const item of (token as Tokens.List).items) {
          collect(item.tokens, parts);
          parts.push("\n");
        }
        break;
      case "image":
        parts.push((token as Tokens.Image).text);
        break;
      case "code":
        parts.push(token.text, "\n");
        break;
      case "codespan":
      case "escape":
        parts.push(token.text);
        break;
      default:
        if ("tokens" in token && token.tokens?.length) {
          collect(token.tokens, parts);
        } else if (token.type === "text") {
          parts.push(token.text);
        }
        if (!INLINE.has(token.type)) parts.push("\n");
    }
  }
}

/**
 * The words a reader sees in a Markdown document, for the search index. Link
 * and image targets, raw HTML, and Markdown syntax are left out, so they
 * neither match a query nor show in a snippet. An image keeps its alt text.
 */
export function markdownToText(markdown: string): string {
  const parts: string[] = [];
  collect(marked.lexer(markdown, { gfm: true }), parts);
  return decodeEntities(parts.join(""))
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n\s*/g, "\n")
    .trim();
}
