import { useSyncExternalStore } from "react";

const MINUTE = 60_000;

let current = Date.now();
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function stop() {
  if (timer === null) return;
  clearTimeout(timer);
  timer = null;
}

/**
 * Wake on the wall-clock minute, so every timestamp on the page changes at the
 * same moment. A displayed time can therefore lag the elapsed time by up to a
 * minute, which is the granularity the display itself has.
 */
function schedule() {
  if (timer !== null || listeners.size === 0 || document.hidden) return;
  timer = setTimeout(
    () => {
      timer = null;
      current = Date.now();
      for (const listener of listeners) listener();
      schedule();
    },
    MINUTE - (Date.now() % MINUTE),
  );
}

// A hidden tab runs no timer. It would render nothing a person can see, and
// browsers throttle it anyway. Catching up on the way back keeps the times
// correct the moment the tab is looked at again.
function onVisibilityChange() {
  if (document.hidden) {
    stop();
    return;
  }
  current = Date.now();
  for (const listener of listeners) listener();
  schedule();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) document.addEventListener("visibilitychange", onVisibilityChange);
  listeners.add(listener);
  schedule();
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    stop();
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}

/**
 * The value is read at import and refreshed by the timer, so a page that sits
 * between the two (a chunk loaded early, a tab restored from the back/forward
 * cache) would render a stale time once. Refreshing a value that is already a
 * minute out closes that gap and keeps the reads within one render identical.
 * The comparison ignores direction so that a clock stepped backwards recovers.
 */
function snapshot(): number {
  if (Math.abs(Date.now() - current) >= MINUTE) current = Date.now();
  return current;
}

/**
 * The shared minute clock. However many timestamps a page renders, they read
 * one value and re-render on one timer.
 */
export function useNow(): Date {
  return new Date(useSyncExternalStore(subscribe, snapshot, snapshot));
}
