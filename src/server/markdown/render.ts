import { marked, Renderer, type Tokens } from "marked";
import { artifactStylesheet } from "./style.ts";

const SAFE_LINK_SCHEMES = new Set(["http:", "https:", "mailto:"]);

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[
      character
    ] as string;
  });
}

function safeLink(value: string): string | null {
  try {
    const url = new URL(value);
    return SAFE_LINK_SCHEMES.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function renderLink(renderer: Renderer, token: Tokens.Link): string {
  const text = renderer.parser.parseInline(token.tokens);
  const href = safeLink(token.href);
  if (!href) return text;
  const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
  return `<a href="${escapeHtml(href)}"${title}>${text}</a>`;
}

/**
 * Renders Markdown as a self-contained page in the Portego style, without
 * letting it add executable or embedded HTML.
 */
export async function markdownToHtml(markdown: string, title: string): Promise<string> {
  const renderer = new Renderer();
  renderer.html = ({ text }) => escapeHtml(text);
  renderer.link = (token) => renderLink(renderer, token);
  renderer.image = (token) => renderer.parser.parseInline(token.tokens);

  // Raw HTML is escaped above, so every table here is one marked wrote.
  const body = marked
    .parse(markdown, { async: false, gfm: true, renderer })
    .replaceAll("<table>", '<div class="artifact-table-wrap"><table>')
    .replaceAll("</table>", "</table></div>");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
${await artifactStylesheet()}
  </style>
</head>
<body>
<div class="artifact-shell">
<main class="artifact-markdown">
${body}</main>
</div>
</body>
</html>
`;
}
