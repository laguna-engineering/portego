import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiError,
  addComment,
  type Comment,
  type CommentAnchor,
  deleteComment,
  fetchComments,
} from "./api.ts";
import { useLiveEvents } from "./live.ts";
import { RelativeTime } from "./RelativeTime.tsx";

export type CommentsProps = {
  artifactId: string;
  currentUserId: string;
  /** A selection pending in the artifact, offered on the next comment. */
  anchor?: CommentAnchor | null;
  onClearAnchor?: () => void;
  /** Called when a comment's quote is clicked, to reveal it in the artifact. */
  onFocusComment?: (id: string) => void;
  /** The comment to highlight in the list, e.g. because it was just revealed. */
  focusedId?: string | null;
  /** False when the container already renders its own "Comments" heading. */
  heading?: boolean;
  /** Reports the current list whenever it changes, e.g. to drive highlights. */
  onComments?: (comments: Comment[]) => void;
  /** The version a new root comment is written on. Omitted writes to the current version. */
  versionId?: string | null;
  /** The version being viewed, to badge a comment written on any other version. */
  viewedVersionNumber?: number | null;
};

const QUOTE_PREVIEW_LIMIT = 120;

/** Shortens a quote for display, the way a preview snippet works. */
function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

type Thread = { root: Comment; replies: Comment[] };

/** Groups a flat, creation-ordered list into root comments and their replies. */
function threadComments(comments: Comment[]): Thread[] {
  const repliesByRoot = new Map<string, Comment[]>();
  for (const comment of comments) {
    if (comment.parentId === null) continue;
    const replies = repliesByRoot.get(comment.parentId) ?? [];
    replies.push(comment);
    repliesByRoot.set(comment.parentId, replies);
  }
  return comments
    .filter((comment) => comment.parentId === null)
    .map((root) => ({ root, replies: repliesByRoot.get(root.id) ?? [] }));
}

/**
 * The comment thread. Comments cannot be edited: the text and the time they
 * were written are the record. An author can remove their own.
 *
 * Used both on the detail page, where there are no anchors or selection, and
 * inside the full-screen comments panel, which offers a pending selection and
 * reacts to a comment's quote being clicked.
 */
export function Comments({
  artifactId,
  currentUserId,
  anchor = null,
  onClearAnchor,
  onFocusComment,
  focusedId = null,
  heading = true,
  onComments,
  versionId = null,
  viewedVersionNumber = null,
}: CommentsProps) {
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  /** The root comment whose inline reply composer is open, if any. */
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [replyProblem, setReplyProblem] = useState<string | null>(null);
  const [replySending, setReplySending] = useState(false);

  const load = useCallback(async () => {
    try {
      setComments(await fetchComments(artifactId));
    } catch (error) {
      setProblem(error instanceof ApiError ? error.message : "Could not read the comments.");
    }
  }, [artifactId]);

  useEffect(() => {
    void load();
  }, [load]);

  // The panel needs every anchored comment's location to highlight it in the
  // artifact, so the parent hears about the list whenever it changes.
  useEffect(() => {
    if (comments) onComments?.(comments);
  }, [comments, onComments]);

  const threads = useMemo(() => threadComments(comments ?? []), [comments]);

  // A reply has no spot of its own to scroll or highlight: its thread's root
  // stands in for it.
  const focusedRootId = useMemo(() => {
    if (!focusedId) return null;
    const target = (comments ?? []).find((comment) => comment.id === focusedId);
    return target?.parentId ?? focusedId;
  }, [focusedId, comments]);

  useEffect(() => {
    if (!focusedRootId) return;
    document.getElementById(`comment-${focusedRootId}`)?.scrollIntoView({ block: "nearest" });
  }, [focusedRootId]);

  useLiveEvents((event) => {
    if (
      event.type === "reconnected" ||
      (event.type === "comment.changed" && event.artifactId === artifactId)
    ) {
      void load();
    }
  });

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (draft.trim() === "") {
      setProblem("Write something first.");
      return;
    }
    setSending(true);
    setProblem(null);
    try {
      const created = await addComment(artifactId, draft, { anchor, versionId });
      // The announcement of this comment may have arrived first and brought it
      // back already. Appending it a second time would show it twice.
      setComments((current) => {
        const listed = current ?? [];
        return listed.some((comment) => comment.id === created.id) ? listed : [...listed, created];
      });
      setDraft("");
      onClearAnchor?.();
    } catch (error) {
      setProblem(error instanceof ApiError ? error.message : "Could not add that comment.");
    } finally {
      setSending(false);
    }
  }

  /** Removing a root takes its replies with it; removing a reply leaves the root. */
  async function remove(id: string) {
    try {
      await deleteComment(artifactId, id);
      setComments((current) =>
        (current ?? []).filter((comment) => comment.id !== id && comment.parentId !== id),
      );
    } catch (error) {
      setProblem(error instanceof ApiError ? error.message : "Could not remove that comment.");
    }
  }

  function openReply(rootId: string) {
    setReplyingTo(rootId);
    setReplyDraft("");
    setReplyProblem(null);
  }

  function cancelReply() {
    setReplyingTo(null);
    setReplyDraft("");
    setReplyProblem(null);
  }

  async function submitReply(event: React.FormEvent, rootId: string) {
    event.preventDefault();
    if (replyDraft.trim() === "") {
      setReplyProblem("Write something first.");
      return;
    }
    setReplySending(true);
    setReplyProblem(null);
    try {
      const created = await addComment(artifactId, replyDraft, { parentId: rootId });
      // Same dedupe as the main composer: the live reload may already have it.
      setComments((current) => {
        const listed = current ?? [];
        return listed.some((comment) => comment.id === created.id) ? listed : [...listed, created];
      });
      cancelReply();
    } catch (error) {
      setReplyProblem(error instanceof ApiError ? error.message : "Could not add that comment.");
    } finally {
      setReplySending(false);
    }
  }

  return (
    <section className="comments">
      {heading ? <h2>Comments</h2> : null}

      {comments === null ? <p className="hint">Loading comments...</p> : null}
      {comments?.length === 0 ? <p className="hint">No comments yet.</p> : null}

      <ul>
        {threads.map(({ root, replies }) => (
          <li
            key={root.id}
            id={`comment-${root.id}`}
            className={root.id === focusedRootId ? "comment focused" : "comment"}
          >
            {root.anchor ? (
              <button
                type="button"
                className="comment-quote"
                onClick={() => onFocusComment?.(root.id)}
              >
                {truncate(root.anchor.quote, QUOTE_PREVIEW_LIMIT)}
              </button>
            ) : null}
            <p className="comment-meta">
              {root.author.name} · <RelativeTime iso={root.createdAt} />
              {viewedVersionNumber != null && root.versionNumber !== viewedVersionNumber ? (
                <span className="badge version-badge">v{root.versionNumber}</span>
              ) : null}
              {root.author.id === currentUserId ? (
                <button type="button" className="link" onClick={() => void remove(root.id)}>
                  Remove
                </button>
              ) : null}
            </p>
            <p className="comment-body">{root.body}</p>

            {replies.length > 0 ? (
              <ul className="comment-replies">
                {replies.map((reply) => (
                  <li key={reply.id} className="comment reply">
                    <p className="comment-meta">
                      {reply.author.name} · <RelativeTime iso={reply.createdAt} />
                      {viewedVersionNumber != null &&
                      reply.versionNumber !== viewedVersionNumber ? (
                        <span className="badge version-badge">v{reply.versionNumber}</span>
                      ) : null}
                      {reply.author.id === currentUserId ? (
                        <button
                          type="button"
                          className="link"
                          onClick={() => void remove(reply.id)}
                        >
                          Remove
                        </button>
                      ) : null}
                    </p>
                    <p className="comment-body">{reply.body}</p>
                  </li>
                ))}
              </ul>
            ) : null}

            {replyingTo === root.id ? (
              <form className="reply-form" onSubmit={(event) => void submitReply(event, root.id)}>
                <label htmlFor={`reply-draft-${root.id}`}>Reply to {root.author.name}</label>
                <textarea
                  id={`reply-draft-${root.id}`}
                  rows={2}
                  value={replyDraft}
                  disabled={replySending}
                  onChange={(event) => setReplyDraft(event.target.value)}
                />
                {replyProblem ? (
                  <p className="problem" role="alert">
                    {replyProblem}
                  </p>
                ) : null}
                <div className="reply-actions">
                  <button type="submit" className="primary" disabled={replySending}>
                    {replySending ? "Posting..." : "Reply"}
                  </button>
                  <button type="button" className="link" onClick={cancelReply}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <button type="button" className="link" onClick={() => openReply(root.id)}>
                Reply
              </button>
            )}
          </li>
        ))}
      </ul>

      <form onSubmit={submit}>
        {anchor ? (
          <div className="pending-selection">
            <blockquote className="comment-quote">
              {truncate(anchor.quote, QUOTE_PREVIEW_LIMIT)}
            </blockquote>
            <button
              type="button"
              className="link"
              onClick={onClearAnchor}
              aria-label="Remove selection"
            >
              ×
            </button>
          </div>
        ) : null}
        <label htmlFor="comment-draft">Add a comment</label>
        <textarea
          id="comment-draft"
          rows={3}
          value={draft}
          disabled={sending}
          onChange={(event) => setDraft(event.target.value)}
        />
        {problem ? (
          <p className="problem" role="alert">
            {problem}
          </p>
        ) : null}
        <button type="submit" className="primary" disabled={sending}>
          {sending ? "Posting..." : "Comment"}
        </button>
      </form>
    </section>
  );
}
