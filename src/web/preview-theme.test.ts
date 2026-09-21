import { expect, test } from "bun:test";

const css = await Bun.file(new URL("./app.css", import.meta.url)).text();

function declaration(selector: string, property: string): string | undefined {
  const rule = new RegExp(`(?:^|\\n)\\${selector}\\s*\\{([^}]*)\\}`).exec(css)?.[1];
  return new RegExp(`(?:^|;|\\n)\\s*${property}\\s*:\\s*([^;]+);`).exec(rule ?? "")?.[1]?.trim();
}

// The frame element paints its own background until the artifact document loads.
// A fixed color shows as a flash on the dark theme.
for (const selector of [".preview", ".preview-full"]) {
  test(`${selector} takes its background from a theme token`, () => {
    expect(declaration(selector, "background")).toMatch(/^var\(--[\w-]+\)$/);
  });
}
