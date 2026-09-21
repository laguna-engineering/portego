import { describe, expect, test } from "bun:test";
import {
  decodeUtf8,
  looksLikeHtml,
  safeFilename,
  TITLE_MAX_LENGTH,
  titleFromHtml,
} from "./html.ts";

describe("titleFromHtml", () => {
  test("reads the document title", () => {
    expect(titleFromHtml("<!doctype html><title>Sales chart</title>")).toBe("Sales chart");
  });

  test("collapses the whitespace a formatted document leaves in the title", () => {
    expect(titleFromHtml("<title>\n  Sales\n  chart\n</title>")).toBe("Sales chart");
  });

  test("decodes the entities a title can carry", () => {
    expect(titleFromHtml("<title>Q3 &amp; Q4 &#8212; sales</title>")).toBe("Q3 & Q4 — sales");
  });

  test("ignores a title that holds only whitespace", () => {
    expect(titleFromHtml("<title>   </title>")).toBeNull();
  });

  test("returns null when the document has no title", () => {
    expect(titleFromHtml("<!doctype html><p>text</p>")).toBeNull();
  });

  test("caps a very long title instead of storing the whole document", () => {
    const long = titleFromHtml(`<title>${"a".repeat(5000)}</title>`);
    expect(long).toHaveLength(TITLE_MAX_LENGTH);
  });

  test("reads a title element that carries attributes", () => {
    expect(titleFromHtml('<title data-x="1">Report</title>')).toBe("Report");
  });
});

describe("safeFilename", () => {
  test("keeps a normal name", () => {
    expect(safeFilename("chart.html")).toBe("chart.html");
  });

  test("keeps only the last segment, so no name can act as a path", () => {
    expect(safeFilename("../../../etc/passwd.html")).toBe("passwd.html");
    expect(safeFilename("C:\\Users\\me\\chart.html")).toBe("chart.html");
  });

  test("falls back to a usable name when nothing is left", () => {
    expect(safeFilename("")).toBe("artifact.html");
    expect(safeFilename(null)).toBe("artifact.html");
    expect(safeFilename("../")).toBe("artifact.html");
  });

  test("removes control characters that would break a response header", () => {
    expect(safeFilename("ch\r\nart.html")).toBe("chart.html");
  });
});

describe("looksLikeHtml", () => {
  test("accepts the documents a build tool produces", () => {
    expect(looksLikeHtml("<!doctype html><html><body></body></html>")).toBe(true);
    expect(looksLikeHtml('<html lang="en"></html>')).toBe(true);
  });

  test("refuses text that only claims to be HTML", () => {
    expect(looksLikeHtml("id,name\n1,a")).toBe(false);
    expect(looksLikeHtml("{}")).toBe(false);
  });
});

describe("decodeUtf8", () => {
  test("returns the text of a valid document", () => {
    expect(decodeUtf8(new TextEncoder().encode("<p>ok</p>"))).toBe("<p>ok</p>");
  });

  test("refuses bytes that are not UTF-8, which cannot be stored as text", () => {
    expect(() => decodeUtf8(new Uint8Array([0xff, 0xfe]))).toThrow(/UTF-8/);
  });
});
