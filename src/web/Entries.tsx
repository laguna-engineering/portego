import { useCallback, useEffect, useState } from "react";
import { ApiError, clearEntry, type Entry, fetchEntries } from "./api.ts";
import { useLiveEvents } from "./live.ts";
import { RelativeTime } from "./RelativeTime.tsx";

const VALUE_PREVIEW_LIMIT = 80;

/** A value on one line, as JSON unless it is plain text. */
function describeValue(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > VALUE_PREVIEW_LIMIT ? `${text.slice(0, VALUE_PREVIEW_LIMIT)}…` : text;
}

export type EntriesProps = {
  artifactId: string;
  currentUserId: string;
  /** Reports the current list whenever it changes, to pass on to the artifact. */
  onEntries?: (entries: Entry[]) => void;
};

/**
 * The data the artifact's page and agents recorded, apart from the discussion.
 * Collapsed, because it is usually read through the page itself. A person can
 * remove their own entries here, including one a page recorded for them.
 */
export function Entries({ artifactId, currentUserId, onEntries }: EntriesProps) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setEntries((await fetchEntries(artifactId)).entries);
    } catch (error) {
      setProblem(error instanceof ApiError ? error.message : "Could not read the data entries.");
    }
  }, [artifactId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    onEntries?.(entries);
  }, [entries, onEntries]);

  useLiveEvents((event) => {
    if (
      event.type === "reconnected" ||
      (event.type === "entry.changed" && event.artifactId === artifactId)
    ) {
      void load();
    }
  });

  async function remove(key: string) {
    try {
      await clearEntry(artifactId, key);
      setEntries((current) =>
        current.filter((entry) => !(entry.key === key && entry.author.id === currentUserId)),
      );
    } catch (error) {
      setProblem(error instanceof ApiError ? error.message : "Could not remove that entry.");
    }
  }

  if (entries.length === 0 && problem === null) return null;

  return (
    <details className="entries">
      <summary>{entries.length === 1 ? "1 data entry" : `${entries.length} data entries`}</summary>
      {problem ? (
        <p className="error" role="alert">
          {problem}
        </p>
      ) : null}
      <ul>
        {entries.map((entry) => (
          <li key={`${entry.author.id} ${entry.key}`} className="entry">
            <p className="entry-data">
              <code>{entry.key}</code> {describeValue(entry.value)}
            </p>
            <p className="comment-meta">
              {entry.author.name} · <RelativeTime iso={entry.updatedAt} />
              {entry.author.id === currentUserId ? (
                <button type="button" className="link" onClick={() => void remove(entry.key)}>
                  Remove
                </button>
              ) : null}
            </p>
          </li>
        ))}
      </ul>
    </details>
  );
}
