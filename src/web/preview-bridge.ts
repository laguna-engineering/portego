import { type RefObject, useEffect } from "react";
import type { CommentAnchor } from "./api.ts";

/**
 * The parent's side of the conversation with a preview. The document in the
 * frame is untrusted, so everything that arrives is checked for shape and cut
 * to size before anything reads it, and nothing sent to it carries a secret.
 */

/** Where a selection sits on screen, relative to the frame's box. */
export type SelectionRect = { top: number; left: number; right: number; bottom: number };

export type BridgeMessage =
  | { type: "ready" }
  | { type: "selection"; anchor: CommentAnchor | null; rect: SelectionRect | null }
  | { type: "focus"; id: string }
  | { type: "open"; url: string }
  | { type: "set"; key: string; value: unknown }
  | { type: "clear"; key: string };

export type BridgeCommand =
  | { type: "mode"; enabled: boolean }
  | { type: "highlights"; anchors: (CommentAnchor & { id: string })[] }
  | { type: "reveal"; id: string }
  | { type: "comments"; comments: PageComment[] }
  | { type: "entries"; entries: PageEntry[] };

/**
 * A comment as the artifact sees it. The author's email is left out: the page
 * is untrusted and has no use for it.
 */
export type PageComment = {
  id: string;
  body: string;
  author: string;
  createdAt: string;
  anchor: CommentAnchor | null;
  parentId: string | null;
  versionNumber: number;
};

/**
 * An entry as the artifact sees it. The author's email stays out: the page is
 * untrusted and has no use for it. The id tells apart two people with one name.
 */
export type PageEntry = {
  key: string;
  value: unknown;
  authorId: string;
  author: string;
  updatedAt: string;
};

const QUOTE_LIMIT = 500;
const CONTEXT_LIMIT = 100;
const ID_LIMIT = 100;
const URL_LIMIT = 2048;
const KEY_LIMIT = 200;
/** The server's limit on a value's JSON text. */
const VALUE_LIMIT = 4000;

function text(value: unknown, limit: number): string | null {
  return typeof value === "string" ? value.slice(0, limit) : null;
}

function readRect(value: unknown): SelectionRect | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const side = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const top = side(raw.top);
  const left = side(raw.left);
  const right = side(raw.right);
  const bottom = side(raw.bottom);
  if (top === null || left === null || right === null || bottom === null) return null;
  return { top, left, right, bottom };
}

/**
 * An absolute http(s) URL, or null. A long one is refused rather than cut,
 * because a cut URL leads somewhere else.
 */
function readUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > URL_LIMIT) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
}

/**
 * A value that survives JSON, so the server stores what the page sent. A long
 * key or value is refused whole, never cut to fit.
 */
function readValue(value: unknown): { value: unknown } | null {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    return null;
  }
  if (json === undefined || new TextEncoder().encode(json).byteLength > VALUE_LIMIT) return null;
  return { value: JSON.parse(json) };
}

function readKey(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= KEY_LIMIT ? value : null;
}

/** Reads one message from a preview. Anything unexpected is null. */
export function readBridgeMessage(data: unknown): BridgeMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const message = data as Record<string, unknown>;
  if (message.portego !== 1) return null;
  if (message.type === "ready") return { type: "ready" };
  if (message.type === "focus") {
    const id = text(message.id, ID_LIMIT);
    return id ? { type: "focus", id } : null;
  }
  if (message.type === "open") {
    const url = readUrl(message.url);
    return url ? { type: "open", url } : null;
  }
  if (message.type === "set") {
    const key = readKey(message.key);
    const read = readValue(message.value);
    return key && read ? { type: "set", key, value: read.value } : null;
  }
  if (message.type === "clear") {
    const key = readKey(message.key);
    return key ? { type: "clear", key } : null;
  }
  if (message.type === "selection") {
    if (message.anchor === null) return { type: "selection", anchor: null, rect: null };
    if (typeof message.anchor !== "object" || message.anchor === null) return null;
    const raw = message.anchor as Record<string, unknown>;
    const quote = text(raw.quote, QUOTE_LIMIT);
    const prefix = text(raw.prefix, CONTEXT_LIMIT);
    const suffix = text(raw.suffix, CONTEXT_LIMIT);
    if (quote === null || quote.trim() === "" || prefix === null || suffix === null) return null;
    return { type: "selection", anchor: { quote, prefix, suffix }, rect: readRect(message.rect) };
  }
  return null;
}

/** Sends a command to the preview. A frame that is not there yet is skipped. */
export function sendToPreview(frame: HTMLIFrameElement | null, command: BridgeCommand): void {
  // The frame's origin is opaque and cannot be named, so the target is "*".
  // Nothing sent this way is secret: a mode flag, quotes the reader already
  // sees, and the comments and entries with author names.
  frame?.contentWindow?.postMessage({ portego: 1, ...command }, "*");
}

/**
 * Opens a link from the preview in a new tab, with no handle on this one and
 * no referrer. A click inside the frame also activates this page, so a
 * document that asks without a click gets nothing, even where the browser's
 * popup blocker is off.
 */
export function openFromPreview(url: string): void {
  if (navigator.userActivation && !navigator.userActivation.isActive) return;
  window.open(url, "_blank", "noopener,noreferrer");
}

/** How long a click or key press leaves a page active, in current browsers. */
export const ACTIVATION_MS = 5000;

/**
 * Input on this page itself. It activates the page just as a click in the
 * frame does, and an artifact that writes during that window, such as right
 * after the click that opened it, would pass for the reader.
 */
const PAGE_INPUT = ["keydown", "mousedown", "pointerdown", "pointerup", "touchend"] as const;

let lastPageInputAt = Number.NEGATIVE_INFINITY;

// Registered when the application loads, not when the artifact page mounts:
// the click that opens an artifact comes before its page exists.
if (typeof window !== "undefined") {
  for (const type of PAGE_INPUT) {
    window.addEventListener(
      type,
      () => {
        lastPageInputAt = performance.now();
      },
      true,
    );
  }
}

/** When this page last had input of its own, in `performance.now()` time. */
export function lastPageInput(): number {
  return lastPageInputAt;
}

/**
 * Whether a write the artifact asks for follows the reader's click inside it.
 * Input inside the frame never reaches this page, so when the page is active
 * and had no input of its own during the activation window, the activation
 * came from the frame. A browser without the activation API is refused: a
 * write is not worth the guess.
 */
export function readerClickState(
  lastPageInput: number,
  now = performance.now(),
): "clicked" | "no-click" | "too-soon" {
  if (navigator.userActivation?.isActive !== true) return "no-click";
  return now - lastPageInput < ACTIVATION_MS ? "too-soon" : "clicked";
}

/** Listens for messages from one frame only. Other windows are ignored. */
export function usePreviewBridge(
  frame: RefObject<HTMLIFrameElement | null>,
  onMessage: (message: BridgeMessage) => void,
): void {
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      const window = frame.current?.contentWindow;
      if (!window || event.source !== window) return;
      const message = readBridgeMessage(event.data);
      if (message) onMessage(message);
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [frame, onMessage]);
}
