import { describe, expect, test } from "bun:test";
import { BRIDGE_SCRIPT, withBridge } from "./bridge.ts";

describe("adding the bridge to a document", () => {
  test("goes at the end of the head, after the charset declaration", () => {
    const html =
      '<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>hi</body></html>';
    const out = withBridge(html);
    expect(out.indexOf("<script>")).toBeGreaterThan(out.indexOf('<meta charset="utf-8">'));
    expect(out.indexOf("</script>")).toBeLessThan(out.indexOf("</head>"));
    // Everything the author wrote is still there, in order.
    expect(out.replace(`<script>${BRIDGE_SCRIPT}</script>`, "")).toBe(html);
  });

  test("goes at the end of the body when there is no head", () => {
    const html = "<body><p>hi</p></BODY>";
    const out = withBridge(html);
    expect(out).toBe(`<body><p>hi</p><script>${BRIDGE_SCRIPT}</script></BODY>`);
  });

  test("is appended to a fragment with neither, which a browser still runs", () => {
    const out = withBridge("<p>hi</p>");
    expect(out).toBe(`<p>hi</p><script>${BRIDGE_SCRIPT}</script>`);
  });

  test("never closes itself early", () => {
    // A "</script>" inside the script would end the tag in the middle of it.
    expect(BRIDGE_SCRIPT).not.toContain("</script");
  });
});
