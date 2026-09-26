/**
 * The script every preview carries so the application can attach comments to
 * a passage. The document runs in an opaque origin, so the page that frames
 * it cannot read a selection made inside. This script reports selections and
 * paints highlights instead, over `postMessage` and nothing else. It also
 * passes link clicks to the page, which opens them in a new tab.
 *
 * The document is untrusted, and it can remove, replace, or imitate this
 * script. Nothing here grants it anything: the parent treats every message as
 * data from a hostile page (see src/web/preview-bridge.ts), and a comment is
 * only ever created by the person who writes it.
 *
 * A passage is a text quote plus a little text on each side, matched against
 * the raw text nodes of the document in order. `Range.toString()` is the same
 * concatenation, so what the reader selected is what is searched for later.
 */
export const BRIDGE_SCRIPT = `(() => {
  if (window.parent === window) return;
  const parent = window.parent;
  const send = (message) => parent.postMessage(Object.assign({ portego: 1 }, message), "*");
  // The page's side of its comments and entries. Entry writes are requests:
  // the application makes them only during the reader's click in the frame,
  // and the result comes back as the next portego:entries event.
  window.portego = {
    comments: [],
    entries: [],
    set: (key, value) => send({ type: "set", key, value }),
    clear: (key) => send({ type: "clear", key }),
  };
  const CONTEXT = 32;
  let mode = false;
  let anchors = [];
  let ranges = new Map();
  let lastSent = "";

  const painted = typeof Highlight !== "undefined" && typeof CSS !== "undefined" && CSS.highlights;
  if (painted) {
    const style = document.createElement("style");
    style.textContent =
      "::highlight(portego-comment){background-color:rgba(255,196,0,0.45)}" +
      "::highlight(portego-comment-active){background-color:rgba(255,140,0,0.75)}";
    (document.head || document.documentElement).appendChild(style);
  }

  function textNodes() {
    const nodes = [];
    const root = document.body || document.documentElement;
    if (!root) return { text: "", nodes };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let text = "";
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      nodes.push({ node, start: text.length });
      text += node.data;
    }
    return { text, nodes };
  }

  function position(nodes, index) {
    let low = 0;
    let high = nodes.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (nodes[mid].start <= index) low = mid;
      else high = mid - 1;
    }
    const entry = nodes[low];
    return entry ? { node: entry.node, offset: index - entry.start } : null;
  }

  function locate(anchor, corpus) {
    const { text, nodes } = corpus;
    let index = text.indexOf(anchor.prefix + anchor.quote + anchor.suffix);
    if (index >= 0) index += anchor.prefix.length;
    else index = text.indexOf(anchor.quote);
    if (index < 0 || anchor.quote === "") return null;
    const start = position(nodes, index);
    const end = position(nodes, index + anchor.quote.length);
    if (!start || !end) return null;
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return range;
  }

  function paint(activeId) {
    if (!painted) return;
    ranges = new Map();
    const corpus = textNodes();
    const all = new Highlight();
    const active = new Highlight();
    for (const anchor of anchors) {
      const range = locate(anchor, corpus);
      if (!range) continue;
      ranges.set(anchor.id, range);
      (anchor.id === activeId ? active : all).add(range);
    }
    CSS.highlights.set("portego-comment", all);
    CSS.highlights.set("portego-comment-active", active);
  }

  function describeSelection() {
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    const quote = range.toString();
    if (quote.trim() === "") return null;
    const root = document.body || document.documentElement;
    const before = document.createRange();
    before.setStart(root, 0);
    before.setEnd(range.startContainer, range.startOffset);
    const after = document.createRange();
    after.setStart(range.endContainer, range.endOffset);
    after.setEnd(root, root.childNodes.length);
    const box = range.getBoundingClientRect();
    return {
      anchor: {
        quote: quote.slice(0, 500),
        prefix: before.toString().slice(-CONTEXT),
        suffix: after.toString().slice(0, CONTEXT),
      },
      // Where the selection is on screen, so the page can put a control next
      // to it. Relative to this frame's viewport, which is the frame's box.
      rect: { top: box.top, left: box.left, right: box.right, bottom: box.bottom },
    };
  }

  let pending = 0;
  function reportSelection() {
    clearTimeout(pending);
    pending = setTimeout(() => {
      const described = describeSelection();
      const key = JSON.stringify(described);
      if (key === lastSent) return;
      lastSent = key;
      send(described ? { type: "selection", ...described } : { type: "selection", anchor: null });
    }, 150);
  }

  document.addEventListener("selectionchange", reportSelection);
  document.addEventListener("mouseup", reportSelection);
  // Scrolling moves the selection on screen without changing it.
  document.addEventListener("scroll", reportSelection, true);

  document.addEventListener("click", (event) => {
    if (!painted || ranges.size === 0) return;
    const caret = document.caretPositionFromPoint
      ? document.caretPositionFromPoint(event.clientX, event.clientY)
      : null;
    const node = caret ? caret.offsetNode : null;
    const offset = caret ? caret.offset : 0;
    if (!node) return;
    for (const [id, range] of ranges) {
      try {
        if (range.isPointInRange(node, offset)) {
          send({ type: "focus", id });
          return;
        }
      } catch (error) {}
    }
  });

  // Most sites refuse to be framed, and the sandbox allows no popups, so the
  // page opens links in a new tab. On the window, this runs after the
  // document's own handlers and skips a click they already handled.
  const follow = (event) => {
    if (event.defaultPrevented || (event.type === "auxclick" && event.button !== 1)) return;
    const link = event
      .composedPath()
      .find((node) => node instanceof Element && node.matches("a[href]"));
    if (!link) return;
    let url;
    try {
      url = new URL(link.getAttribute("href"), document.baseURI);
    } catch (error) {
      return;
    }
    if (url.origin === location.origin) return;
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    event.preventDefault();
    send({ type: "open", url: url.href });
  };
  window.addEventListener("click", follow);
  window.addEventListener("auxclick", follow);

  window.addEventListener("message", (event) => {
    if (event.source !== parent) return;
    const message = event.data;
    if (!message || message.portego !== 1) return;
    if (message.type === "mode") {
      mode = message.enabled === true;
      document.documentElement.style.cursor = mode ? "text" : "";
    } else if (message.type === "highlights") {
      anchors = Array.isArray(message.anchors) ? message.anchors : [];
      paint(null);
    } else if (message.type === "comments") {
      const comments = Array.isArray(message.comments) ? message.comments : [];
      window.portego.comments = comments;
      window.dispatchEvent(new CustomEvent("portego:comments", { detail: comments }));
    } else if (message.type === "entries") {
      const entries = Array.isArray(message.entries) ? message.entries : [];
      window.portego.entries = entries;
      window.dispatchEvent(new CustomEvent("portego:entries", { detail: entries }));
    } else if (message.type === "reveal") {
      paint(message.id);
      const range = ranges.get(message.id);
      if (!range) return;
      const rect = range.getBoundingClientRect();
      window.scrollTo({ top: window.scrollY + rect.top - window.innerHeight / 3, behavior: "smooth" });
    }
  });

  let repaint = 0;
  const observer = new MutationObserver(() => {
    if (anchors.length === 0) return;
    clearTimeout(repaint);
    repaint = setTimeout(() => paint(null), 200);
  });
  const watch = () => {
    if (document.body) observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    send({ type: "ready" });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watch);
  else watch();
})();`;

const BRIDGE_TAG = `<script>${BRIDGE_SCRIPT}</script>`;

/**
 * Puts the bridge into a document. At the end of the head where there is one,
 * so a charset declaration stays within the bytes the browser sniffs; else at
 * the end of the body; else appended. A document with none of these still
 * runs it, because a browser closes the open elements at the end.
 */
export function withBridge(html: string): string {
  for (const closing of [/<\/head\s*>/i, /<\/body\s*>/i]) {
    const match = closing.exec(html);
    if (match) {
      return `${html.slice(0, match.index)}${BRIDGE_TAG}${html.slice(match.index)}`;
    }
  }
  return `${html}${BRIDGE_TAG}`;
}
