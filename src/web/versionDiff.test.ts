import { describe, expect, test } from "bun:test";
import { changeRuns, type DiffRow, diffRows } from "./versionDiff.ts";

/** Each side as text, with changed runs in brackets. */
function show(rows: DiffRow[]) {
  const side = (segments: DiffRow["left"]) =>
    segments?.map((s) => (s.changed ? `[${s.text}]` : s.text)).join("") ?? null;
  return rows.map((row) => [side(row.left), side(row.right)]);
}

describe("diffRows", () => {
  test("pairs an edited line with its old form and marks only the changed words", () => {
    expect(show(diffRows("Title\nSales rose in Q3\n", "Title\nSales fell in Q3\n"))).toEqual([
      ["Title", "Title"],
      ["Sales [rose] in Q3", "Sales [fell] in Q3"],
    ]);
  });

  test("leaves the other side empty for lines that exist on one side only", () => {
    expect(show(diffRows("a\nb\nc\n", "a\nnew\nc\nend\n"))).toEqual([
      ["a", "a"],
      ["[b]", "[new]"],
      ["c", "c"],
      [null, "[end]"],
    ]);
    expect(show(diffRows("a\nb\nc\n", "a\n")).slice(1)).toEqual([
      ["[b]", null],
      ["[c]", null],
    ]);
  });

  test("keeps alignment when a changed block shrinks", () => {
    expect(show(diffRows("x\nold one\nold two\ny", "x\nnew one\ny"))).toEqual([
      ["x", "x"],
      ["[old] one", "[new] one"],
      ["[old two]", null],
      ["y", "y"],
    ]);
  });

  test("flags unchanged rows so identical texts read as having no changes", () => {
    expect(diffRows("same\ntext", "same\ntext").some((row) => row.changed)).toBe(false);
    expect(diffRows("same\ntext", "same\ntext!").some((row) => row.changed)).toBe(true);
  });
});

describe("changeRuns", () => {
  const before = "same\nedited one\nremoved\nsame\nsame\ngone\nsame\n";
  const after = "same\nedited two\nsame\nsame\nnew\nsame\n";

  test("every changed row belongs to a run and unchanged rows split runs", () => {
    expect(changeRuns(diffRows(before, after))).toEqual([
      { first: 1, last: 2, kind: "changed" },
      { first: 5, last: 5, kind: "changed" },
    ]);
  });

  // A removal must stay visible on the minimap even where the text view hides it.
  test("names a run by what its rows add or remove", () => {
    expect(changeRuns(diffRows("a\n", "a\nb\n"))).toEqual([{ first: 1, last: 1, kind: "added" }]);
    expect(changeRuns(diffRows("a\nb\n", "a\n"))).toEqual([{ first: 1, last: 1, kind: "removed" }]);
    expect(changeRuns(diffRows("one two\n", "one\n"))).toEqual([
      { first: 0, last: 0, kind: "removed" },
    ]);
    expect(changeRuns(diffRows("one\n", "one two\n"))).toEqual([
      { first: 0, last: 0, kind: "added" },
    ]);
    expect(changeRuns(diffRows("a\n\nb\n", "a\n"))).toEqual([
      { first: 1, last: 2, kind: "removed" },
    ]);
    expect(changeRuns(diffRows("a\n", "a\n\nb\n"))).toEqual([{ first: 1, last: 2, kind: "added" }]);
  });
});
