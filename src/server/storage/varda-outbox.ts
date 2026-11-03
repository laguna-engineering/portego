import type { Database } from "bun:sqlite";

/** One event for Varda. `data` is JSON text; ids only increase, also after deletes. */
export type VardaRow = { id: number; data: string };

/**
 * The Varda integration's outbox: events Varda has not acknowledged yet.
 * docs/varda-integration.md describes the rows and the stream that reads them.
 */
export type VardaOutbox = {
  /**
   * Writes a row and returns its id, or null when a row with this GitHub
   * delivery id is already stored. It can run inside a transaction, so it never
   * calls the listeners: the caller announces the row after the commit.
   */
  insert: (data: string, delivery?: string) => number | null;
  /** Every row, oldest first. */
  backlog: () => VardaRow[];
  remove: (ids: number[]) => void;
  /** Deletes the rows written before this time, in milliseconds. */
  prune: (before: number) => void;
  /** Calls the listener with each announced row. Returns the unsubscribe function. */
  onRow: (listener: (row: VardaRow) => void) => () => void;
  announce: (row: VardaRow) => void;
};

/**
 * The listeners are kept here, apart from the event bus, so the streams of
 * /api/events never see these rows.
 */
export function createVardaOutbox(options: { database: Database }): VardaOutbox {
  const { database } = options;
  const listeners = new Set<(row: VardaRow) => void>();

  return {
    insert(data, delivery) {
      const result = database
        .query(
          `insert into vardaOutbox (data, delivery, createdAt) values (?, ?, ?)
           on conflict (delivery) do nothing`,
        )
        .run(data, delivery ?? null, Date.now());
      return result.changes > 0 ? Number(result.lastInsertRowid) : null;
    },

    backlog() {
      return database.query("select id, data from vardaOutbox order by id").all() as VardaRow[];
    },

    remove(ids) {
      if (ids.length === 0) return;
      database
        .query(`delete from vardaOutbox where id in (${ids.map(() => "?").join(", ")})`)
        .run(...ids);
    },

    prune(before) {
      database.query("delete from vardaOutbox where createdAt < ?").run(before);
    },

    onRow(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    announce(row) {
      // A listener that throws must not stop the others or fail the write.
      for (const listener of [...listeners]) {
        try {
          listener(row);
        } catch (cause) {
          console.error("Varda outbox listener failed", cause);
        }
      }
    },
  };
}
