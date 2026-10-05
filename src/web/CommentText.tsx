import type { ReactNode } from "react";
import { type CommentNode, parseComment } from "../shared/comment-format.ts";

function render(node: CommentNode, key: number): ReactNode {
  if (typeof node === "string") return node;
  const children = node.children.map(render);
  if (node.tag === "a") {
    return (
      <a key={key} href={node.href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  }
  const Tag = node.tag;
  return <Tag key={key}>{children}</Tag>;
}

/** Text written by people, with the formatting comments support. */
export function CommentText({ text }: { text: string }) {
  return <>{parseComment(text).map(render)}</>;
}
