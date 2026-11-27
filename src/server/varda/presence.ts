/**
 * How long Varda counts as connected after its last stream closed. Varda
 * reconnects after each token expiry and after a dropped connection, and a
 * page should not flicker through those gaps.
 */
export const PRESENCE_GRACE_MS = 30_000;

/** Whether Varda's listener holds a stream open, for the pages it reads. */
export type VardaPresence = {
  connected: () => boolean;
  /** Counts a stream as open. Returns the function to call once it closes. */
  open: () => () => void;
};

/** `onChange` runs when `connected()` changes. */
export function createVardaPresence(
  options: { graceMs?: number; onChange?: () => void } = {},
): VardaPresence {
  const graceMs = options.graceMs ?? PRESENCE_GRACE_MS;
  let streams = 0;
  let connected = false;
  let grace: ReturnType<typeof setTimeout> | null = null;

  const set = (value: boolean) => {
    if (connected === value) return;
    connected = value;
    options.onChange?.();
  };

  return {
    connected: () => connected,
    open() {
      streams += 1;
      if (grace !== null) clearTimeout(grace);
      grace = null;
      set(true);
      let closed = false;
      return () => {
        if (closed) return;
        closed = true;
        streams -= 1;
        if (streams > 0) return;
        grace = setTimeout(() => {
          grace = null;
          set(false);
        }, graceMs);
      };
    },
  };
}
