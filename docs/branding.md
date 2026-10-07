# Branding

A deployment can change the name, logos, icons, and colors of the web
application without rebuilding it. `APP_NAME` sets the name. `BRANDING_DIR`
names a directory of replacement files.

```sh
APP_NAME=Acme Share
BRANDING_DIR=/etc/portego/branding
```

## Name

The server writes `APP_NAME` into every page it serves: the page title, the
`application-name` and `og:site_name` tags, and the social image's alt text.
The sign-in page reads it from there, so it shows the name before anyone signs
in. The OAuth consent screen and the root of the folder panel use it too, and
link previews of pages that are not artifacts take it as their title.

## Files

Each file is optional. A file the directory does not hold is served from the
client build, so a deployment can replace one logo and keep the rest.

| File | Size of the default | Where it appears |
| --- | --- | --- |
| `logo-full.png` | 400 × 400 | The sign-in page |
| `logo-mark.png` | 96 × 96 | The masthead, at 22 × 22 |
| `logo-label.png` | 249 × 66 | The masthead, next to the mark |
| `favicon-32.png` | 32 × 32 | The browser tab |
| `apple-touch-icon.png` | 180 × 180 | iOS home screen |
| `social-preview.png` | 400 × 400 | Link previews in chat and social apps |
| `brand.css` | none | Loaded after the application stylesheet |

`logo-label.png` is a mask. Only its alpha channel counts: the masthead fills
the shape with the text color, so the label follows light and dark mode. Draw it
in one color on a transparent background. The masthead keeps the default's
proportions and puts the baseline 50 of 66 rows down. For a label with other
proportions, set the width in `brand.css`:

```css
.wordmark-label::before {
  width: calc(var(--label-height) * 320 / 66);
}
```

The server reads the directory once, when it starts. Restart it after changing
a file. Browsers check each file on every page load and get an empty
`304 Not Modified` while their copy is current, so a replaced file shows on the
next load after the restart.

The Vite development server always shows the defaults. Run `bun run build` and
`bun run start` to see a branding directory.

## Stylesheet

`brand.css` loads after the application stylesheet, so a rule with the same
specificity wins. The colors and fonts are custom properties on `:root`, set
once for light mode and again inside `@media (prefers-color-scheme: dark)`.
Override both:

```css
:root {
  --accent: #b5361f;
}

@media (prefers-color-scheme: dark) {
  :root {
    --accent: #e0664f;
  }
}
```

[`src/web/app.css`](../src/web/app.css) lists the properties. The other class
names in it are internal and can change in any release. Rely on the custom
properties where you can.

Artifact previews do not use `brand.css`: Markdown renders in the bundled
style, and HTML artifacts bring their own.
