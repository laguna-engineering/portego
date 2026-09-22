import { ServiceError } from "./artifacts/errors.ts";
import type { ArtifactService } from "./artifacts/service.ts";
import type { Auth } from "./auth/auth.ts";

/** Same paths the client router treats as one artifact's page. */
const ARTIFACT_PATH = /^\/a\/([^/]+)(?:\/full)?\/?$/;
const EXCERPT_LENGTH = 200;
const SITE_NAME = "Portego";

export type PageMeta = {
  title: string;
  /** Present only for a signed-in request. */
  description: string | null;
};

/**
 * Social tags for the page at `path`, or null for a page that is not a
 * readable artifact. Link unfurlers send no cookie, so an anonymous request
 * gets the title only: whoever holds the link can read it, and nothing more.
 */
export async function pageMeta(
  path: string,
  headers: Headers,
  deps: { auth: Auth; artifacts: ArtifactService },
): Promise<PageMeta | null> {
  const id = artifactIdFromPath(path);
  if (id === null) return null;

  try {
    const artifact = deps.artifacts.get(id);
    if (artifact.archivedAt) return null;

    const session = await deps.auth.api.getSession({ headers });
    if (!session) return { title: artifact.title, description: null };

    const description =
      artifact.description?.trim() || excerpt((await deps.artifacts.markdown(id)).markdown) || null;
    return { title: artifact.title, description };
  } catch (error) {
    if (error instanceof ServiceError) return null;
    throw error;
  }
}

function artifactIdFromPath(path: string): string | null {
  const match = path.match(ARTIFACT_PATH);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/**
 * Adds the per-page social tags to the built index.html. Crawlers need an
 * absolute image URL, and Vite writes a root-relative one.
 */
export function withSocialTags(
  html: string,
  meta: PageMeta | null,
  page: { appOrigin: string; path: string },
): string {
  const title = meta?.title ?? SITE_NAME;
  const tags = [
    `<meta property="og:title" content="${escapeHtml(title)}" />`,
    `<meta property="og:url" content="${escapeHtml(page.appOrigin + page.path)}" />`,
  ];
  if (meta?.description) {
    tags.push(
      `<meta name="description" content="${escapeHtml(meta.description)}" />`,
      `<meta property="og:description" content="${escapeHtml(meta.description)}" />`,
    );
  }

  let result = html.replace(
    /(<meta property="og:image" content=")(\/[^"]*)"/,
    (_, start: string, imagePath: string) => `${start}${page.appOrigin}${imagePath}"`,
  );
  if (meta) {
    const pageTitle = `<title>${escapeHtml(meta.title)}</title>`;
    result = result.replace(/<title>[^<]*<\/title>/, () => pageTitle);
  }
  return result.replace("</head>", () => `    ${tags.join("\n    ")}\n  </head>`);
}

/** The opening prose of a Markdown document as one line of plain text. */
export function excerpt(markdown: string): string {
  const lines: string[] = [];
  let inFence = false;
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    // Headings repeat the title or name a section; tables and rules carry no prose.
    if (inFence || line === "" || /^(#|\||[-*_]{3,}$)/.test(line)) continue;
    lines.push(stripInline(line));
    if (lines.join(" ").length > EXCERPT_LENGTH) break;
  }
  return truncate(lines.join(" ").replace(/\s+/g, " ").trim());
}

function stripInline(line: string): string {
  return line
    .replace(/^(>\s*)+/, "")
    .replace(/^([-*+]|\d+[.)])\s+/, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*+|`+|~~/g, "");
}

function truncate(text: string): string {
  if (text.length <= EXCERPT_LENGTH) return text;
  const cut = text.slice(0, EXCERPT_LENGTH);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).replace(/[\s.,;:]+$/, "")}…`;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
