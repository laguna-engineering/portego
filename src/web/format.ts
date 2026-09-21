const UNITS = ["B", "KiB", "MiB"] as const;

export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? value : Math.round(value * 10) / 10;
  return `${rounded} ${UNITS[unit]}`;
}

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

const YEAR_SECONDS = 31_557_600;

const STEPS: [unit: Intl.RelativeTimeFormatUnit, seconds: number][] = [
  ["minute", 60],
  ["hour", 3600],
  ["day", 86_400],
  ["week", 604_800],
  ["month", 2_629_800],
];

/**
 * "3 hours ago". The display stops at the minute, so anything newer reads
 * "less than a minute ago". A clock a few seconds out of step with the server
 * lands in that same range, which is why the floor covers both directions.
 * Falls back to a date once an artifact is over a year old.
 */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  const seconds = (then.getTime() - now.getTime()) / 1000;
  const magnitude = Math.abs(seconds);
  if (magnitude >= YEAR_SECONDS) return then.toLocaleDateString();
  if (magnitude < 60) return "less than a minute ago";

  let [unit, size] = STEPS[0] as [Intl.RelativeTimeFormatUnit, number];
  for (const step of STEPS) {
    if (magnitude >= step[1]) [unit, size] = step;
  }
  return RELATIVE.format(Math.round(seconds / size), unit);
}

export function excerpt(text: string, limit = 140): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= limit) return collapsed;
  return `${collapsed.slice(0, limit - 1).trimEnd()}\u2026`;
}

/** The full timestamp, for the tooltip behind a relative time. */
export function absoluteTime(iso: string): string {
  return new Date(iso).toLocaleString();
}
