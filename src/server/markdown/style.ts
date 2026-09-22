import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import mono400 from "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2" with {
  type: "file",
};
import sans400 from "@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2" with {
  type: "file",
};
import sans600 from "@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff2" with {
  type: "file",
};
import serif400 from "@fontsource/ibm-plex-serif/files/ibm-plex-serif-latin-400-normal.woff2" with {
  type: "file",
};
import serif500 from "@fontsource/ibm-plex-serif/files/ibm-plex-serif-latin-500-normal.woff2" with {
  type: "file",
};
import artifact from "../../../tools/portego-upload/style/portego/artifact.css" with {
  type: "text",
};
import tokens from "../../../tools/portego-upload/style/portego/tokens.css" with { type: "text" };

/** The files tokens.css names under ./assets/fonts/, by the name it uses. */
const fonts: Record<string, string> = {
  "ibm-plex-mono-latin-400-normal.woff2": mono400,
  "ibm-plex-sans-latin-400-normal.woff2": sans400,
  "ibm-plex-sans-latin-600-normal.woff2": sans600,
  "ibm-plex-serif-latin-400-normal.woff2": serif400,
  "ibm-plex-serif-latin-500-normal.woff2": serif500,
};

async function fontDataUrl(file: string): Promise<string> {
  // The bundle names its copied assets relative to itself.
  const path = isAbsolute(file) ? file : join(import.meta.dir, file);
  return `data:font/woff2;base64,${(await readFile(path)).toString("base64")}`;
}

async function build(): Promise<string> {
  let css = tokens;
  for (const [name, file] of Object.entries(fonts)) {
    css = css.replace(`url("./assets/fonts/${name}")`, `url("${await fontDataUrl(file)}")`);
  }
  if (/url\(\s*["']?\.\//.test(css)) {
    throw new Error("tokens.css names a font this module does not embed.");
  }
  return `${css}\n\n${artifact}`;
}

let stylesheet: Promise<string> | undefined;

/** The Portego stylesheet with its fonts embedded, so a page carrying it needs no network. */
export function artifactStylesheet(): Promise<string> {
  stylesheet ??= build();
  return stylesheet;
}
