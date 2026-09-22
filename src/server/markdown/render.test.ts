import { describe, expect, test } from "bun:test";
import { markdownToHtml } from "./render.ts";

describe("markdownToHtml", () => {
  test("renders a static document without raw HTML, scripts, or images", async () => {
    const html = await markdownToHtml(
      "# Report\n\n<script>run()</script>\n\n[Safe](https://example.com) [Unsafe](javascript:run())\n\n![Chart](https://example.com/chart.png)",
      "Report",
    );

    expect(html).toContain("<title>Report</title>");
    expect(html).toContain("<h1>Report</h1>");
    expect(html).toContain("&lt;script&gt;run()&lt;/script&gt;");
    expect(html).toContain('<a href="https://example.com/">Safe</a>');
    expect(html).toContain("Unsafe");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<img");
  });

  test("styles the page like a Portego artifact with nothing left to fetch", async () => {
    const html = await markdownToHtml("| a | b |\n|---|---|\n| 1 | 2 |\n", "Table");

    expect(html).toContain('<main class="artifact-markdown">');
    expect(html).toContain('<div class="artifact-table-wrap"><table>');
    expect(html).toContain('font-family: "IBM Plex Serif"');
    expect(html).toContain("data:font/woff2;base64,");
    // Every font the stylesheet names is embedded; a relative URL would 404.
    expect(html).not.toContain("./assets/fonts/");
  });
});
