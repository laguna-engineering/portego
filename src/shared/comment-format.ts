/**
 * Comment formatting: `code`, *bold*, _italic_, ~strikethrough~, and http(s)
 * URLs as links. Text inside code stays literal.
 *
 * The preview bridge embeds these functions in untrusted pages by their source
 * text, so each one must not refer to anything outside its own body.
 */

export type CommentNode =
  | string
  | { tag: "a"; href: string; children: CommentNode[] }
  | { tag: "code" | "strong" | "em" | "del"; children: CommentNode[] };

export function parseComment(text: string): CommentNode[] {
  const CODE = /`([^`\n]+)`/g;
  const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/g;
  // Sentence punctuation and emphasis markers after a URL end the sentence or
  // the emphasis, not the URL.
  const URL_TRAILER = ".,;:!?'\")]*_~";
  const WORD = /[\p{L}\p{N}_]/u;
  const SPACE = /\s/;
  const EMPHASIS: Record<string, "strong" | "em" | "del"> = { "*": "strong", _: "em", "~": "del" };

  type Range = { start: number; end: number };

  const count = (value: string, char: string) => value.split(char).length - 1;

  function trimUrl(url: string): string {
    let end = url.length;
    while (end > 0 && URL_TRAILER.includes(url[end - 1] ?? "")) {
      // Keep a closing parenthesis the URL opened, as in Wikipedia links.
      const head = url.slice(0, end);
      if (url[end - 1] === ")" && count(head, "(") >= count(head, ")")) break;
      end -= 1;
    }
    return url.slice(0, end);
  }

  function findUrls(segment: string): Range[] {
    const ranges: Range[] = [];
    for (const match of segment.matchAll(URL_PATTERN)) {
      const url = trimUrl(match[0]);
      if (/^https?:\/\/$/.test(url)) continue;
      ranges.push({ start: match.index, end: match.index + url.length });
    }
    return ranges;
  }

  const insideUrl = (urls: Range[], index: number) =>
    urls.some((url) => index >= url.start && index < url.end);

  // A marker opens emphasis at the start of a word and closes it at the end of
  // one, so snake_case and 2*3*4 stay plain. A doubled marker stays plain, and
  // emphasis does not cross lines.
  function closingMarker(segment: string, open: number, end: number, urls: Range[]) {
    const marker = segment[open];
    const before = segment[open - 1];
    const next = segment[open + 1];
    if (before !== undefined && (WORD.test(before) || before === marker)) return null;
    if (next === undefined || next === marker || SPACE.test(next)) return null;
    for (let close = open + 2; close < end; close++) {
      const char = segment[close];
      if (char === "\n") return null;
      if (char !== marker || insideUrl(urls, close)) continue;
      if (SPACE.test(segment[close - 1] ?? "")) continue;
      const after = segment[close + 1];
      if (after !== undefined && WORD.test(after)) continue;
      return close;
    }
    return null;
  }

  function inline(segment: string, start: number, end: number, urls: Range[]): CommentNode[] {
    const nodes: CommentNode[] = [];
    let plain = "";
    const flush = () => {
      if (plain) nodes.push(plain);
      plain = "";
    };
    let index = start;
    while (index < end) {
      const url = urls.find((range) => range.start === index);
      if (url && url.end <= end) {
        flush();
        const href = segment.slice(url.start, url.end);
        nodes.push({ tag: "a", href, children: [href] });
        index = url.end;
        continue;
      }
      const char = segment[index] ?? "";
      const tag = EMPHASIS[char];
      if (tag && !insideUrl(urls, index)) {
        const close = closingMarker(segment, index, end, urls);
        if (close !== null) {
          flush();
          nodes.push({ tag, children: inline(segment, index + 1, close, urls) });
          index = close + 1;
          continue;
        }
      }
      plain += char;
      index += 1;
    }
    flush();
    return nodes;
  }

  const nodes: CommentNode[] = [];
  const addText = (segment: string) => {
    nodes.push(...inline(segment, 0, segment.length, findUrls(segment)));
  };
  let last = 0;
  for (const match of text.matchAll(CODE)) {
    addText(text.slice(last, match.index));
    nodes.push({ tag: "code", children: [match[1] ?? ""] });
    last = match.index + match[0].length;
  }
  addText(text.slice(last));
  return nodes;
}

/** Replaces the element's content with the nodes, as text and elements only. */
export function renderCommentNodes(nodes: CommentNode[], element: Element): void {
  const build = (node: CommentNode): Node => {
    if (typeof node === "string") return element.ownerDocument.createTextNode(node);
    const child = element.ownerDocument.createElement(node.tag);
    if (node.tag === "a") child.setAttribute("href", node.href);
    for (const inner of node.children) child.appendChild(build(inner));
    return child;
  };
  element.replaceChildren(...nodes.map(build));
}
