## Visual direction

Use a quiet, content-first interface that matches the public Portego application.

- Use the supplied CSS tokens and components. Do not replace their colors, typefaces, spacing, borders, or radii.
- Use warm flat surfaces, one restrained verdigris accent, and muted rust only for errors or serious risks.
- Use IBM Plex Serif for display headings, IBM Plex Sans for normal text, and IBM Plex Mono only for code, filenames, and small technical labels.
- Use flat color. Do not use gradients, textures, glass effects, card shadows, decorative illustrations, or animation without a functional reason.
- Prefer a single readable column. Use grids only when the content benefits from comparison.
- Keep borders one pixel wide. Cards and sections use the supplied radius.
- Use sentence case. Avoid all-caps headings, slogans, emoji, exclamation marks, and marketing language.
- Write direct, complete sentences. State errors and constraints factually.
- Keep the document responsive. At narrow widths, grids must become one column and wide tables must scroll.
- Use semantic HTML, a useful heading hierarchy, visible keyboard focus, table headings, and alt text for meaningful images.

## Document structure

- Start with one clear title and a short summary.
- Put the conclusion or recommendation before supporting detail.
- Use sections with descriptive headings.
- Use callouts sparingly for the most important decision, warning, or next step.
- Use tables for comparisons, not for general page layout.
- Keep code samples short and horizontally scrollable.
- End with decisions, next steps, or provenance when they are relevant.

## Technical constraints

- The final document must be one self-contained HTML file.
- Do not add network-loaded scripts, styles, fonts, images, frames, or media.
- Keep links as normal anchors. Portego blocks document network requests but readers can still use explicit links where the browser policy permits.
- Use the provided `data-portego-style` marker. The finalizer replaces it with the selected style and embeds its local font and image resources.
