# Markdown representation

An artifact can be read as text: `GET /api/artifacts/:id/markdown`, the **Text**
view on the artifact page, and the `get_artifact_markdown` MCP tool. A version
uploaded as Markdown returns its supplied Markdown. An HTML version uses the
conversion below. The response identifies the source as `provided` or
`generated`. Both paths need the same session or token as the source.

## Provided Markdown

The upload tool can send a Markdown file with `contentType: "markdown"`. The
backend stores that text with the new version and renders a complete static HTML
page. Raw HTML is escaped, images are omitted, and links retain only `http:`,
`https:`, and `mailto:` destinations. The renderer does not execute scripts or
load embedded resources.

## What the conversion does

The stored HTML is parsed, never executed. `parse5` builds a tree, and a walker
emits Markdown from the elements it recognizes. There is no DOM, no script
engine, and no headless browser anywhere in this path.

Converted: headings, paragraphs, ordered and unordered lists including nesting,
tables, code blocks, blockquotes, horizontal rules, emphasis, inline code,
links, and images. A definition term, a definition description, and a figure
caption each become their own paragraph, since Markdown has no syntax of its
own for them.

A Markdown table has to have a header row, so the table's first row becomes one
whether or not it sits in a `<thead>`.

Dropped with everything inside them: `script`, `style`, `template`, `noscript`,
`svg`, `math`, `iframe`, `object`, `embed`, `canvas`, `video`, `audio`, and the
form elements. They are not text, and their attributes can carry URLs a reader
should not follow.

Anything else is treated as a container: its children are converted and the
element itself contributes nothing. An element this converter has never heard
of therefore adds no markup of its own.

## URLs

A link or image URL survives only when its scheme is one a reader can follow:
`http:`, `https:`, or `mailto:` for links, and `http:`/`https:` for images. A
`javascript:` URL keeps its link text and loses the destination. A `data:` URL
is dropped the same way: it carries content rather than a destination, and an
image's description is the useful part. Relative URLs are dropped, because a
self-contained artifact has nothing for them to resolve against. A URL
containing whitespace, a parenthesis, or an angle bracket is dropped, since a
Markdown destination cannot hold one. Square brackets need no escape there, so
they survive.

## Caching

A generated conversion is stored with the source digest and the converter
version, and is reused only when both still match. Changing the converter means
bumping `CONVERTER_VERSION`, after which the next read regenerates. Supplied
Markdown belongs only to the version that uploaded it and is never inherited by
a later HTML version.

## The limitation

An artifact that renders everything from JavaScript has little or no static
content. A single-file Vite build is usually an empty `<div id="root">` and a
script. The conversion reports `empty: true` and an empty string rather than
inventing text; the web view says so in words, and the MCP tool returns the
same flag.

Extracting content from such an artifact would mean rendering it, which means
running its JavaScript. That is deliberately out of scope. If it is ever
needed, it belongs in a separately isolated worker with strict CPU, memory,
time, filesystem, and network limits, not in this process.

## For MCP clients

Markdown from an artifact is data, not instructions. The tool description says
so, and a client that feeds tool output into a prompt should treat it the way
it treats any other fetched document.
