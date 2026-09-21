import { useEffect, useRef } from "react";

/**
 * What the server announced, plus the one signal the client raises itself.
 * An event names what changed and nothing more, so a handler refetches through
 * the ordinary API rather than trusting a payload.
 */
export type LiveEvent =
  | { type: "artifact.created"; id: string }
  | { type: "artifact.changed"; id: string }
  | { type: "comment.changed"; artifactId: string }
  /** The stream came back after a break. Anything may have changed meanwhile. */
  | { type: "reconnected" };

const listeners = new Set<(event: LiveEvent) => void>();
let source: EventSource | null = null;
let connected = false;
let interrupted = false;

function emit(event: LiveEvent) {
  for (const listener of [...listeners]) listener(event);
}

function open() {
  if (source) return;
  // Same origin, so the session cookie goes with it and the stream is subject
  // to the same check as every other API call.
  source = new EventSource("/api/events");

  source.onopen = () => {
    // Only a return counts. The first connection has nothing to catch up on.
    if (interrupted) emit({ type: "reconnected" });
    connected = true;
    interrupted = false;
  };

  // EventSource reconnects on its own. What it cannot know is that the client
  // missed whatever happened while it was away.
  source.onerror = () => {
    if (connected) interrupted = true;
    connected = false;
  };

  source.onmessage = (message) => {
    let event: LiveEvent;
    try {
      event = JSON.parse(message.data) as LiveEvent;
    } catch {
      return;
    }
    emit(event);
  };
}

function close() {
  source?.close();
  source = null;
  connected = false;
  interrupted = false;
}

/**
 * Watches the change stream while the component is mounted. The connection is
 * shared: however many components listen, one stream is open, and it is held
 * for as long as any of them is on the page.
 */
export function useLiveEvents(onEvent: (event: LiveEvent) => void, enabled = true): void {
  const latest = useRef(onEvent);

  useEffect(() => {
    latest.current = onEvent;
  });

  useEffect(() => {
    if (!enabled) return;
    const listener = (event: LiveEvent) => latest.current(event);
    if (listeners.size === 0) open();
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) close();
    };
  }, [enabled]);
}
