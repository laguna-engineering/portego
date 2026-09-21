import { useNow } from "./clock.ts";
import { absoluteTime, formatRelativeTime } from "./format.ts";

export type RelativeTimeProps = { iso: string };

/**
 * A timestamp that keeps itself current. The element carries the machine
 * readable value and the full time, so the rounded text is never the only
 * record of when something happened.
 */
export function RelativeTime({ iso }: RelativeTimeProps) {
  const now = useNow();
  return (
    <time dateTime={iso} title={absoluteTime(iso)}>
      {formatRelativeTime(iso, now)}
    </time>
  );
}
