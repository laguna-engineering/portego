import { ServiceError } from "./errors.ts";

export const TITLE_MAX_LENGTH = 200;
export const DESCRIPTION_MAX_LENGTH = 2000;
export const FILENAME_MAX_LENGTH = 255;

/**
 * Decodes an upload as UTF-8 and refuses anything else. An artifact is a text
 * document that has to survive being read back and sent again unchanged.
 */
export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ServiceError("UNSUPPORTED_CONTENT", "The file is not valid UTF-8 text.");
  }
}

/**
 * The uploaded MIME type and filename are hints a client chooses, so the
 * document itself has to look like HTML.
 */
export function looksLikeHtml(text: string): boolean {
  return /<!doctype\s+html|<html[\s>]/i.test(text);
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, name: string) => {
    const known = ENTITIES[name.toLowerCase()];
    if (known) return known;
    if (name.startsWith("#")) {
      const code = name.toLowerCase().startsWith("#x")
        ? Number.parseInt(name.slice(2), 16)
        : Number(name.slice(1));
      if (Number.isInteger(code) && code > 0 && code <= 0x10ffff) return String.fromCodePoint(code);
    }
    return match;
  });
}

/** The document's own title, when it has a usable one. */
export function titleFromHtml(text: string): string | null {
  const match = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match?.[1]) return null;
  const title = decodeEntities(match[1].replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
  if (title === "") return null;
  return title.slice(0, TITLE_MAX_LENGTH);
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

/**
 * The filename is recorded for the download and shown to people. It is never
 * used as a path: the last segment only, with control characters removed.
 */
export function safeFilename(name: string | null | undefined): string {
  const last = (name ?? "").split(/[\\/]/).at(-1) ?? "";
  const cleaned = last.replace(CONTROL_CHARACTERS, "").trim();
  if (cleaned === "" || cleaned === "." || cleaned === "..") return "artifact.html";
  return cleaned.slice(0, FILENAME_MAX_LENGTH);
}
