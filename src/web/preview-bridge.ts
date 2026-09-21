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
  | { type: "focus"; id: string };

export type BridgeCommand =
  | { type: "mode"; enabled: boolean }
  | { type: "highlights"; anchors: (CommentAnchor & { id: string })[] }
  | { type: "reveal"; id: string };

const QUOTE_LIMIT = 500;
const CONTEXT_LIMIT = 100;
const ID_LIMIT = 100;

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
  // sees, and comment ids.
  frame?.contentWindow?.postMessage({ portego: 1, ...command }, "*");
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
