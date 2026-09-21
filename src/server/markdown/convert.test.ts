import { describe, expect, test } from "bun:test";
import { htmlToMarkdown, safeUrl } from "./convert.ts";

function convert(body: string): string {
  return htmlToMarkdown(
    `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`,
  ).markdown;
}

describe("static content", () => {
  test("converts headings and paragraphs", () => {
    expect(convert("<h1>Title</h1><p>First.</p><h2>Section</h2><p>Second.</p>")).toBe(
      "# Title\n\nFirst.\n\n## Section\n\nSecond.",
    );
  });

  test("converts both kinds of list, including nesting", () => {
    expect(convert("<ul><li>one</li><li>two<ul><li>inner</li></ul></li></ul>")).toBe(
      "- one\n- two\n  - inner",
    );
    expect(convert("<ol><li>first</li><li>second</li></ol>")).toBe("1. first\n2. second");
  });

  test("converts a table with its header row", () => {
    const html =
      "<table><thead><tr><th>Name</th><th>Count</th></tr></thead>" +
      "<tbody><tr><td>a</td><td>1</td></tr></tbody></table>";
    expect(convert(html)).toBe("| Name | Count |\n| --- | --- |\n| a | 1 |");
  });

  test("gives a table with no header row the first row it has", () => {
    // A Markdown table cannot exist without a header, so the choice is which
    // row becomes one. The first row is the only one a reader would expect.
    const html =
      "<table><tbody><tr><td>a</td><td>1</td></tr><tr><td>b</td><td>2</td></tr></tbody></table>";
    expect(convert(html)).toBe("| a | 1 |\n| --- | --- |\n| b | 2 |");
  });

  test("converts definition lists and figure captions as their own paragraphs", () => {
    // Markdown has no syntax for a term, a description, or a caption, and
    // dropping them would lose text a reader wrote.
    expect(convert("<dl><dt>Term</dt><dd>What it means.</dd></dl>")).toBe("Term\n\nWhat it means.");
    expect(
      convert(
        '<figure><img src="https://example.test/a.png" alt="chart"><figcaption>A chart.</figcaption></figure>',
      ),
    ).toBe("![chart](https://example.test/a.png)\n\nA chart.");
  });

  test("keeps a code block unescaped, which is the point of a code block", () => {
    expect(convert("<pre><code>const x = a * b;\nreturn x;</code></pre>")).toBe(
      "```\nconst x = a * b;\nreturn x;\n```",
    );
  });

  test("converts inline emphasis, code, and quotes", () => {
    expect(convert("<p><strong>bold</strong> and <em>italic</em> and <code>x*y</code></p>")).toBe(
      "**bold** and *italic* and `x*y`",
    );
    expect(convert("<blockquote><p>quoted</p></blockquote>")).toBe("> quoted");
  });

  test("collapses the whitespace a formatted document carries", () => {
    expect(convert("<p>\n  one\n  two\n</p>")).toBe("one two");
  });

  test("escapes characters that would otherwise be Markdown syntax", () => {
    expect(convert("<p>a * b _c_ [d]</p>")).toBe("a \\* b \\_c\\_ \\[d\\]");
  });

  test("produces the same output every time, so a cached conversion stays valid", () => {
    const html = "<h1>T</h1><ul><li>a</li></ul><p>text</p>";
    expect(convert(html)).toBe(convert(html));
  });
});

describe("scripts and styles", () => {
  test("drops scripts without running them", () => {
    const html = "<p>before</p><script>document.title = 'taken'; alert(1)</script><p>after</p>";
    const markdown = convert(html);
    expect(markdown).toBe("before\n\nafter");
    expect(markdown).not.toContain("alert");
  });

  test("drops styles, templates, and inline SVG", () => {
    const html =
      "<style>body{color:red}</style><template><p>hidden</p></template>" +
      "<svg><script>alert(1)</script><text>label</text></svg><p>kept</p>";
    expect(convert(html)).toBe("kept");
  });

  test("drops embedded and interactive elements that have no text meaning", () => {
    const html =
      '<iframe src="https://example.test"></iframe><form><input value="x"><button>Go</button></form>' +
      "<canvas></canvas><p>kept</p>";
    expect(convert(html)).toBe("kept");
  });
});

describe("URLs", () => {
  test("keeps an ordinary link", () => {
    expect(convert('<p><a href="https://example.test/page">docs</a></p>')).toBe(
      "[docs](https://example.test/page)",
    );
  });

  test("keeps the text of a javascript: link and drops the URL", () => {
    expect(convert(`<p><a href="javascript:alert(1)">click</a></p>`)).toBe("click");
  });

  test("drops a data: URL, which carries content rather than a destination", () => {
    expect(convert('<p><a href="data:text/html,<script>alert(1)</script>">click</a></p>')).toBe(
      "click",
    );
  });

  test("drops a relative link, which points nowhere from a self-contained document", () => {
    expect(convert('<p><a href="/admin">internal</a></p>')).toBe("internal");
  });

  test("keeps an image with a followable source, and the alt text otherwise", () => {
    expect(convert('<p><img src="https://example.test/a.png" alt="a chart"></p>')).toBe(
      "![a chart](https://example.test/a.png)",
    );
    expect(convert('<p><img src="data:image/png;base64,AAAA" alt="a chart"></p>')).toBe("a chart");
  });

  test("drops a URL carrying a character the link syntax cannot hold", () => {
    const https = new Set(["https:"]);
    for (const url of [
      "https://example.test/a b",
      "https://example.test/a(1).html",
      "https://example.test/a)1(.html",
      "https://example.test/a<1>.html",
    ]) {
      expect(safeUrl(url, https), url).toBeNull();
    }
    // Square brackets need no escape inside a destination, so they stay.
    expect(safeUrl("https://example.test/a[1].html", https)).toBe("https://example.test/a[1].html");
  });
});

describe("empty documents", () => {
  test("reports a document whose content comes from JavaScript", () => {
    const result = htmlToMarkdown(
      '<!doctype html><html><head><title>App</title></head><body><div id="root"></div>' +
        "<script>render()</script></body></html>",
    );
    expect(result.empty).toBe(true);
    expect(result.markdown).toBe("");
  });

  test("reports a document with text as not empty", () => {
    expect(htmlToMarkdown("<p>something</p>").empty).toBe(false);
  });
});
