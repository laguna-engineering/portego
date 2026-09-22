import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ArtifactStyleError,
  finalizeArtifact,
  prepareArtifactDraft,
  resolveArtifactStyle,
  summarizeArtifactStyle,
  validateArtifactHtml,
} from "./style.ts";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "portego-style-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const validHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Report</title>
  <style>body { color: #111; }</style>
</head>
<body><h1>Report</h1><a href="https://example.com/source">Source</a></body>
</html>`;

describe("artifact validation", () => {
  test("accepts a self-contained document and allows normal links", () => {
    expect(validateArtifactHtml(validHtml)).toEqual({
      valid: true,
      byteSize: Buffer.byteLength(validHtml),
      issues: [],
    });
  });

  test("rejects resources and scripts that need the network", () => {
    const result = validateArtifactHtml(`<!doctype html>
      <html lang="en"><head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Remote</title><style>.x { background: url('/image.png'); }</style></head>
      <body><h1>Remote</h1><img src="https://example.com/a.png"><script>fetch('/api')</script></body></html>`);
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "css-resource",
      "image-alt",
      "external-resource",
      "script-network",
    ]);
  });

  test("rejects CSS imports", () => {
    const result = validateArtifactHtml(
      '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Imported</title><style>@import url("x.css");</style></head><body><h1>Imported</h1></body></html>',
    );
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("css-import");
  });

  test("reports accessibility and document metadata as warnings", () => {
    const result = validateArtifactHtml("<title>Small</title><p>Text</p>");
    expect(result.valid).toBe(true);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "html-parse",
      "doctype",
      "viewport",
      "language",
      "heading",
    ]);
  });
});

describe("artifact style resolution", () => {
  test("uses the bundled Portego style by default", async () => {
    const directory = await temporaryDirectory();
    const style = await resolveArtifactStyle({
      cwd: directory,
      configHome: join(directory, "config"),
      stylePath: "",
    });
    const summary = await summarizeArtifactStyle(style);
    expect(summary.name).toBe("Portego");
    expect(summary.source).toBe("bundled");
    expect(summary.templates.map((template) => template.name)).toEqual([
      "dashboard",
      "decision",
      "report",
    ]);
    expect(summary.instructions).toContain("quiet, content-first");
  });

  test("uses a style from the user config directory", async () => {
    const directory = await temporaryDirectory();
    const configHome = join(directory, "config");
    const styleDirectory = join(configHome, "portego", "artifact-style");
    await mkdir(styleDirectory, { recursive: true });
    await writeFile(
      join(styleDirectory, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        name: "Personal",
        extends: "portego",
        styles: ["tokens.css"],
      }),
    );
    await writeFile(join(styleDirectory, "tokens.css"), ":root { --accent: #345678; }");

    const style = await resolveArtifactStyle({
      cwd: directory,
      configHome,
      stylePath: "",
    });
    expect(style.name).toBe("Personal");
    expect(style.source).toBe("user");
  });

  test("refuses a malformed manifest", async () => {
    const directory = await temporaryDirectory();
    const styleDirectory = join(directory, "style");
    await mkdir(styleDirectory, { recursive: true });
    await writeFile(join(styleDirectory, "manifest.json"), '{"schemaVersion": 2}');

    await expect(resolveArtifactStyle({ stylePath: styleDirectory })).rejects.toThrow(
      "Invalid artifact style manifest",
    );
  });

  test("refuses a style file that escapes through a symlink", async () => {
    const directory = await temporaryDirectory();
    const styleDirectory = join(directory, "style");
    const outside = join(directory, "outside.css");
    await mkdir(styleDirectory, { recursive: true });
    await writeFile(outside, ":root { --accent: red; }");
    await symlink(outside, join(styleDirectory, "tokens.css"));
    await writeFile(
      join(styleDirectory, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        name: "Escaped",
        extends: "portego",
        styles: ["tokens.css"],
      }),
    );

    expect(resolveArtifactStyle({ stylePath: styleDirectory })).rejects.toThrow(
      "outside the style directory",
    );
  });

  test("finds a project style and extends the bundled style", async () => {
    const directory = await temporaryDirectory();
    const styleDirectory = join(directory, ".portego", "artifact-style");
    const nested = join(directory, "one", "two");
    await mkdir(styleDirectory, { recursive: true });
    await mkdir(nested, { recursive: true });
    await writeFile(
      join(styleDirectory, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        name: "Project",
        extends: "portego",
        instructions: "DESIGN.md",
        styles: ["tokens.css"],
      }),
    );
    await writeFile(join(styleDirectory, "DESIGN.md"), "Use the project accent.");
    await writeFile(join(styleDirectory, "tokens.css"), ":root { --accent: #123456; }");

    const style = await resolveArtifactStyle({
      cwd: nested,
      configHome: join(directory, "config"),
      stylePath: "",
    });
    const summary = await summarizeArtifactStyle(style);
    expect(summary.name).toBe("Project");
    expect(summary.source).toBe("project");
    expect(summary.styleFiles.at(-1)).toBe(join(styleDirectory, "tokens.css"));
    expect(summary.instructions).toContain("Use the project accent.");
    expect(summary.templates.some((template) => template.name === "report")).toBe(true);
  });
});

describe("artifact preparation", () => {
  test("prepares a small draft and finalizes it with embedded fonts", async () => {
    const directory = await temporaryDirectory();
    const draft = join(directory, "report.html");
    const prepared = await prepareArtifactDraft({
      path: draft,
      title: "A <safe> report",
      cwd: directory,
      configHome: join(directory, "config"),
      stylePath: "",
    });
    expect(prepared.template).toBe("report");
    const source = await readFile(draft, "utf8");
    expect(source).toContain("<title>A &lt;safe&gt; report</title>");
    expect(source).toContain('data-portego-style="Portego"');
    expect(source).toContain("data-portego-style-digest=");
    expect(source).not.toContain("base64");

    const finalized = await finalizeArtifact({
      path: draft,
      cwd: directory,
      configHome: join(directory, "config"),
      stylePath: "",
    });
    const html = await readFile(finalized.path, "utf8");
    expect(finalized.path).toBe(join(directory, "report.portego.html"));
    expect(finalized.style).toBe("Portego");
    expect(finalized.warnings).toEqual([]);
    expect(html).toContain("data:font/woff2;base64,");
    expect(html).not.toContain("./assets/fonts/");
    expect(validateArtifactHtml(html).valid).toBe(true);
  });

  test("refuses to finalize a draft with a style other than the prepared one", async () => {
    const directory = await temporaryDirectory();
    const draft = join(directory, "report.html");
    const styleDirectory = join(directory, "style");
    await mkdir(styleDirectory, { recursive: true });
    await writeFile(
      join(styleDirectory, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        name: "Changed",
        extends: "portego",
        styles: ["tokens.css"],
      }),
    );
    await writeFile(join(styleDirectory, "tokens.css"), ":root { --accent: #123456; }");
    await prepareArtifactDraft({ path: draft, title: "Report" });

    await expect(finalizeArtifact({ path: draft, stylePath: styleDirectory })).rejects.toThrow(
      "prepared with a different style",
    );
    await expect(
      finalizeArtifact({ path: draft, stylePath: styleDirectory, allowStyleChange: true }),
    ).resolves.toMatchObject({ style: "Changed" });
  });

  test("refuses CSS that closes its style element", async () => {
    const directory = await temporaryDirectory();
    const styleDirectory = join(directory, "style");
    const draft = join(directory, "report.html");
    await mkdir(styleDirectory, { recursive: true });
    await writeFile(
      join(styleDirectory, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        name: "Injected",
        extends: "portego",
        styles: ["tokens.css"],
      }),
    );
    await writeFile(join(styleDirectory, "tokens.css"), "</style><script>run()</script>");
    await prepareArtifactDraft({ path: draft, title: "Injected", stylePath: styleDirectory });

    await expect(finalizeArtifact({ path: draft, stylePath: styleDirectory })).rejects.toThrow(
      "cannot be embedded safely",
    );
  });

  test("refuses a style that loads a remote resource", async () => {
    const directory = await temporaryDirectory();
    const styleDirectory = join(directory, "style");
    const draft = join(directory, "report.html");
    await mkdir(join(styleDirectory, "templates"), { recursive: true });
    await writeFile(
      join(styleDirectory, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        name: "Remote",
        styles: ["style.css"],
        templates: { report: { path: "templates/report.html", description: "Report" } },
      }),
    );
    await writeFile(
      join(styleDirectory, "style.css"),
      "body { background: url(https://x.test/a); }",
    );
    await writeFile(
      join(styleDirectory, "templates", "report.html"),
      '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>{{TITLE}}</title><style data-portego-style></style></head><body><h1>{{TITLE}}</h1></body></html>',
    );
    await prepareArtifactDraft({ path: draft, title: "Remote", stylePath: styleDirectory });
    expect(finalizeArtifact({ path: draft, stylePath: styleDirectory })).rejects.toThrow(
      ArtifactStyleError,
    );
  });
});
