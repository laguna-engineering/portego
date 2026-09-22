import { describe, expect, test } from "bun:test";
import { excerpt, withSocialTags } from "./social.ts";

describe("excerpt", () => {
  test("joins the opening prose into one line", () => {
    expect(excerpt("Conversion improved this quarter.\n\nMore detail follows.")).toBe(
      "Conversion improved this quarter. More detail follows.",
    );
  });

  test("skips a leading heading and starts from the first paragraph", () => {
    expect(excerpt("# Q3 report\n\nRevenue grew 12% quarter over quarter.")).toBe(
      "Revenue grew 12% quarter over quarter.",
    );
  });

  test("skips fenced code blocks, which carry no prose", () => {
    const markdown = "```js\nconst x = fetchRevenue();\n```\n\nRevenue grew 12%.";
    expect(excerpt(markdown)).toBe("Revenue grew 12%.");
  });

  test("skips table rows and horizontal rules", () => {
    const markdown = "| a | b |\n| - | - |\n\n---\n\nThe real summary sentence.";
    expect(excerpt(markdown)).toBe("The real summary sentence.");
  });

  test("strips inline emphasis, code spans, and links to their text", () => {
    const markdown =
      "The **bold** claim uses `code` and a [link](https://example.com) to prove it.";
    expect(excerpt(markdown)).toBe("The bold claim uses code and a link to prove it.");
  });

  test("drops images entirely rather than leaving their alt text", () => {
    expect(excerpt("Before the chart. ![Revenue chart](/chart.png) After the chart.")).toBe(
      "Before the chart. After the chart.",
    );
  });

  test("strips blockquote and list markers", () => {
    expect(excerpt("> A quoted opening line.")).toBe("A quoted opening line.");
    expect(excerpt("- First point of the summary.")).toBe("First point of the summary.");
    expect(excerpt("1. First point of the summary.")).toBe("First point of the summary.");
  });

  test("cuts at ~200 characters on a word boundary with an ellipsis", () => {
    const markdown = "word ".repeat(60).trim();
    const result = excerpt(markdown);
    expect(result.length).toBeLessThanOrEqual(201);
    expect(result.endsWith("…")).toBe(true);
    // The cut never lands mid-word: strip the ellipsis and every remaining
    // character must be one of the repeated "word" tokens.
    expect(result.slice(0, -1).trim()).toMatch(/^(word ?)+$/);
  });

  test("returns an empty string for markdown that is only structure, no prose", () => {
    expect(excerpt("# Title\n\n```js\ncode();\n```\n\n| a |\n| - |\n\n---")).toBe("");
  });
});

describe("withSocialTags", () => {
  const page = { appOrigin: "https://portego.example", path: "/a/abc123" };
  const html =
    "<!doctype html><html><head><title>Portego</title>" +
    '<meta property="og:image" content="/assets/logo-full-abc.png" />' +
    "</head><body></body></html>";

  test("rewrites the root-relative og:image to an absolute URL on the app origin", () => {
    const result = withSocialTags(html, null, page);
    expect(result).toContain(
      '<meta property="og:image" content="https://portego.example/assets/logo-full-abc.png" />',
    );
  });

  test("falls back to the generic title and leaves <title> unchanged for a non-artifact page", () => {
    const result = withSocialTags(html, null, page);
    expect(result).toContain('<meta property="og:title" content="Portego" />');
    expect(result).toContain("<title>Portego</title>");
    expect(result).not.toContain('name="description"');
    expect(result).not.toContain("og:description");
  });

  test("sets og:url to the app origin plus the requested path", () => {
    const result = withSocialTags(html, null, page);
    expect(result).toContain(
      '<meta property="og:url" content="https://portego.example/a/abc123" />',
    );
  });

  test("an anonymous artifact view (title, no description) gets a matching <title> and og:title but no description tags", () => {
    // The privacy rule: whoever holds a link learns the title, never the content.
    const result = withSocialTags(html, { title: "Q3 Roadmap", description: null }, page);
    expect(result).toContain('<meta property="og:title" content="Q3 Roadmap" />');
    expect(result).toContain("<title>Q3 Roadmap</title>");
    expect(result).not.toContain('name="description"');
    expect(result).not.toContain("og:description");
  });

  test("a signed-in artifact view adds og:description and the description meta", () => {
    const result = withSocialTags(
      html,
      { title: "Q3 Roadmap", description: "What shipped and what's next." },
      page,
    );
    expect(result).toContain(
      '<meta name="description" content="What shipped and what\'s next." />',
    );
    expect(result).toContain(
      '<meta property="og:description" content="What shipped and what\'s next." />',
    );
  });

  test("escapes a title with $&, quotes, and angle brackets so the markup cannot break", () => {
    const meta = { title: `A "special" <title> & $& case`, description: null };
    const result = withSocialTags(html, meta, page);
    expect(result).toContain(
      '<meta property="og:title" content="A &quot;special&quot; &lt;title&gt; &amp; $&amp; case" />',
    );
    expect(result).toContain(
      "<title>A &quot;special&quot; &lt;title&gt; &amp; $&amp; case</title>",
    );
    // The original raw string must never appear unescaped: that would either
    // break the tag or (for $&) get swallowed by String.replace's special syntax.
    expect(result).not.toContain(meta.title);
  });

  test("inserts all tags before </head>, after any existing head content", () => {
    const result = withSocialTags(html, { title: "Q3 Roadmap", description: "Summary." }, page);
    const headEnd = result.indexOf("</head>");
    expect(result.indexOf('og:title"')).toBeGreaterThan(-1);
    expect(result.indexOf('og:title"')).toBeLessThan(headEnd);
    expect(result.indexOf("og:description")).toBeLessThan(headEnd);
  });
});
