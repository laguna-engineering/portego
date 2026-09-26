/**
 * What changed. The payload carries identifiers only: a subscriber refetches
 * through the ordinary API, so every answer stays subject to the checks that
 * route already makes, and the stream never holds a body of its own.
 */
export type ChangeEvent =
  | { type: "artifact.created"; id: string }
  | { type: "artifact.changed"; id: string }
  | { type: "comment.changed"; artifactId: string }
  | { type: "entry.changed"; artifactId: string }
  | { type: "folder.changed"; id: string }
  | { type: "tag.changed"; id: string };

export type EventBus = {
  publish: (event: ChangeEvent) => void;
  subscribe: (listener: (event: ChangeEvent) => void) => () => void;
  /** Open subscriptions. The stream route reads it to enforce its limit. */
  readonly size: number;
};

/**
 * An in-process fan-out. One Bun process serves the whole application and
 * there is no shared bus, so a listener registered here reaches every client
 * connected to this process, which today means every client. A second process
 * or a second host would need a bus both of them can read, and this is where
 * that assumption lives.
 */
export function createEventBus(): EventBus {
  const listeners = new Set<(event: ChangeEvent) => void>();

  return {
    get size() {
      return listeners.size;
    },

    publish(event) {
      // A listener that throws must not stop the others, and must not fail the
      // write whose commit published this event.
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch (cause) {
          console.error("event listener failed", cause);
        }
      }
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
