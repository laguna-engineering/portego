import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { parseComment, renderCommentNodes } from "../shared/comment-format.ts";
import { CommentText } from "./CommentText.tsx";

function html(text: string): string {
  return render(<CommentText text={text} />).container.innerHTML;
}

const LINK = 'target="_blank" rel="noopener noreferrer"';

describe("comment text", () => {
  test("links http and https URLs and leaves other schemes as text", () => {
    expect(html("see https://acme.example/a?b=1 now")).toBe(
      `see <a href="https://acme.example/a?b=1" ${LINK}>https://acme.example/a?b=1</a> now`,
    );
    expect(html("javascript:alert(1) ftp://acme.example")).toBe(
      "javascript:alert(1) ftp://acme.example",
    );
  });

  test("ends a URL before the punctuation that ends the sentence", () => {
    expect(html("Read http://acme.example/x.")).toBe(
      `Read <a href="http://acme.example/x" ${LINK}>http://acme.example/x</a>.`,
    );
    expect(html("(see https://acme.example/x)")).toBe(
      `(see <a href="https://acme.example/x" ${LINK}>https://acme.example/x</a>)`,
    );
    // A parenthesis the URL opened belongs to it.
    expect(html("https://en.wikipedia.org/wiki/Foo_(bar)")).toBe(
      `<a href="https://en.wikipedia.org/wiki/Foo_(bar)" ${LINK}>https://en.wikipedia.org/wiki/Foo_(bar)</a>`,
    );
  });

  test("does not link a URL inside code, so people can quote one literally", () => {
    expect(html("run `curl https://acme.example/*x*`")).toBe(
      "run <code>curl https://acme.example/*x*</code>",
    );
  });

  test("formats bold, italic, and strikethrough, nested or around a link", () => {
    expect(html("*bold* _italic_ ~gone~")).toBe(
      "<strong>bold</strong> <em>italic</em> <del>gone</del>",
    );
    expect(html("*_both_*")).toBe("<strong><em>both</em></strong>");
    expect(html("*see https://acme.example*")).toBe(
      `<strong>see <a href="https://acme.example" ${LINK}>https://acme.example</a></strong>`,
    );
  });

  test("leaves markers inside words, URLs, and loose text alone", () => {
    for (const text of [
      "snake_case_name",
      "2*3*4",
      "a * b * c",
      "**not markdown**",
      "*unclosed",
      "*across\nlines*",
    ]) {
      expect(html(text)).toBe(text);
    }
    expect(html("https://acme.example/_a_/b")).toBe(
      `<a href="https://acme.example/_a_/b" ${LINK}>https://acme.example/_a_/b</a>`,
    );
  });

  test("renders markup as text, so a comment cannot inject HTML", () => {
    expect(html('<img src=x onerror="alert(1)"> *hi*')).toBe(
      '&lt;img src=x onerror="alert(1)"&gt; <strong>hi</strong>',
    );
  });
});

describe("rendering into a page", () => {
  test("works from the functions' source alone, which is how the preview bridge carries them", () => {
    const [parse, renderNodes] = new Function(
      `${parseComment}\n${renderCommentNodes}\nreturn [parseComment, renderCommentNodes];`,
    )() as [typeof parseComment, typeof renderCommentNodes];
    const element = document.createElement("p");
    element.textContent = "old";

    renderNodes(parse("*Hi* <b>x</b> https://acme.example `y`"), element);

    expect(element.innerHTML).toBe(
      '<strong>Hi</strong> &lt;b&gt;x&lt;/b&gt; <a href="https://acme.example">https://acme.example</a> <code>y</code>',
    );
  });
});
