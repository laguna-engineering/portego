import { describe, expect, test } from "bun:test";
import { type DiffRow, diffRows } from "./versionDiff.ts";

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
