import { diffLines, diffWords } from "diff";

/** A run of text on one side of a row. `changed` marks text the other side lacks. */
export type Segment = { text: string; changed: boolean };

/** One aligned line pair. A null side has no line at this position. */
export type DiffRow = { left: Segment[] | null; right: Segment[] | null; changed: boolean };

function splitLines(value: string): string[] {
  const lines = value.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function whole(line: string): Segment[] {
  return line ? [{ text: line, changed: true }] : [];
}

/**
 * Aligns two texts line by line. A removed block followed by an added block
 * is paired line for line and diffed word by word, so an edited paragraph
 * shows which words changed instead of a full removal and addition.
 */
export function diffRows(before: string, after: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let removed: string[] = [];

  const flushRemoved = () => {
    for (const line of removed) rows.push({ left: whole(line), right: null, changed: true });
    removed = [];
  };

  for (const change of diffLines(before, after)) {
    const lines = splitLines(change.value);
    if (change.removed) {
      flushRemoved();
      removed = lines;
    } else if (change.added) {
      lines.forEach((line, index) => {
        const old = removed[index];
        rows.push(
          old === undefined
            ? { left: null, right: whole(line), changed: true }
            : pairWords(old, line),
        );
      });
      removed = removed.slice(lines.length);
      flushRemoved();
    } else {
      flushRemoved();
      for (const line of lines) {
        const same = [{ text: line, changed: false }];
        rows.push({ left: same, right: same, changed: false });
      }
    }
  }
  flushRemoved();
  return rows;
}

function pairWords(before: string, after: string): DiffRow {
  const left: Segment[] = [];
  const right: Segment[] = [];
  for (const part of diffWords(before, after)) {
    if (!part.added) left.push({ text: part.value, changed: Boolean(part.removed) });
    if (!part.removed) right.push({ text: part.value, changed: Boolean(part.added) });
  }
  return { left, right, changed: true };
}

export type DiffMode = "inline" | "split";

/** Consecutive changed rows, by index into the rows. */
export type ChangeRun = { first: number; last: number; kind: "added" | "removed" | "changed" };

/**
 * Groups the changed rows a mode shows into runs. Inline mode highlights only
 * new text, so rows whose only change is a removal are left out.
 */
export function changeRuns(rows: DiffRow[], mode: DiffMode): ChangeRun[] {
  const runs: ChangeRun[] = [];
  let current: ChangeRun | null = null;
  rows.forEach((row, index) => {
    const shown = mode === "inline" ? Boolean(row.right?.some((s) => s.changed)) : row.changed;
    if (!shown) {
      current = null;
      return;
    }
    const kind = !row.left ? "added" : !row.right ? "removed" : "changed";
    if (current) {
      current.last = index;
      if (current.kind !== kind) current.kind = "changed";
    } else {
      current = { first: index, last: index, kind };
      runs.push(current);
    }
  });
  return runs;
}
