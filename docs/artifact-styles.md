# Artifact styles

The `portego-upload` plugin can create an editable HTML draft, apply a selected
style, validate the final document, and upload it without carrying the document
through the conversation. The bundled Portego style follows the public web
application's colors, typography, spacing, and writing conventions.

A style is a directory with a `manifest.json`. It can replace the bundled style
or extend it with a small set of overrides. It contains presentation guidance,
CSS, and HTML templates. The local upload tool resolves and applies it. The
Portego server never runs a custom style: a Markdown upload is rendered with
the bundled Portego CSS and fonts, and nothing else.

## Resolution order

The first available style wins:

1. A path passed explicitly to a style tool or command.
2. `PORTEGO_ARTIFACT_STYLE`, including the Claude plugin's `style` setting.
3. `.portego/artifact-style/`, searched from the working directory through its parents.
4. `$XDG_CONFIG_HOME/portego/artifact-style/`, or `~/.config/portego/artifact-style/`.
5. The Portego style bundled with `portego-upload`.

An explicit path can name the directory or its `manifest.json`.

## Manifest

This project style changes the accent and adds presentation guidance while
inheriting the Portego CSS, fonts, and templates:

```json
{
  "schemaVersion": 1,
  "name": "Acme",
  "extends": "portego",
  "instructions": "DESIGN.md",
  "styles": ["tokens.css"],
  "templates": {
    "review": {
      "path": "templates/review.html",
      "description": "An Acme design review."
    }
  }
}
```

Every referenced path must be relative and stay inside the style directory.
`extends` currently accepts only `portego`. Inherited instructions and styles
run first. Templates with the same name replace their inherited template.

A complete style that does not extend Portego must define at least one CSS file
and one template.

## Templates

A template is ordinary HTML with three placeholders:

- `{{TITLE}}` receives an HTML-escaped title.
- `{{STYLE_NAME}}` receives the selected style name.
- `<style data-portego-style></style>` marks where the finalizer embeds CSS. Preparation records the selected style digest on this element.

Use `<main data-portego-content>` for the part an agent is expected to replace.
The marker makes a draft small enough to edit. `finalize_artifact` writes a
separate `.portego.html` file containing the selected CSS and assets.

## CSS and assets

List CSS files in application order. A style can reference local images and
fonts with relative `url(...)` values. The finalizer replaces each one with a
data URL. The asset must remain inside the style directory.

Remote URLs and `@import` are refused. Artifacts render with no network access,
so a style must carry every resource it needs.

The build stages the bundled IBM Plex font files and the SIL Open Font License
1.1 from the pinned Fontsource packages. Its generated artifacts contain only
the selected Latin font files and remain below the default 5 MiB upload limit.

## Validation

`validate_artifact` and the `validate` command check:

- upload size;
- a non-empty title;
- external scripts, styles, images, fonts, frames, and media;
- CSS imports and non-inline CSS resources;
- network APIs in inline scripts;
- blocked embeds, form actions, base URLs, and meta refresh;
- document language, viewport, doctype, headings, and image alt text.

Errors make the file unsuitable for Portego. Warnings identify metadata and
basic accessibility problems that should normally be fixed.

## Commands

The same operations are available without an MCP client:

```sh
npx -y portego-upload style
npx -y portego-upload prepare draft.html --title "Architecture review" --template report
# Edit draft.html.
npx -y portego-upload finalize draft.html
npx -y portego-upload validate draft.portego.html
npx -y portego-upload upload draft.portego.html
```

Use `--style <path>` with `prepare` and `finalize` to select one explicitly.
Use `--output <path>` with `finalize` to choose the final file name. A draft
finalizes only with the style that prepared it. Use `--allow-style-change` to
replace that recorded style deliberately.

## Trust

A project or user style supplies instructions to the artifact-creation agent.
Choose it as carefully as other project instructions. Style guidance controls
presentation only. It cannot select a deployment, grant authorization, or
permit unrelated commands. Only the user configures the upload origin.
