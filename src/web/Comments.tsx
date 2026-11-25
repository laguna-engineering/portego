import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  addComment,
  type Comment,
  type CommentAnchor,
  deleteComment,
  fetchComments,
  setCommentSolved,
} from "./api.ts";
import { CommentText } from "./CommentText.tsx";
import { CheckIcon } from "./Icons.tsx";
import { useLiveEvents } from "./live.ts";
import { MemberLink } from "./Member.tsx";
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
  /** Reports whether solved threads are shown, e.g. to highlight their passages. */
  onShowSolvedChange?: (shown: boolean) => void;
};

const QUOTE_PREVIEW_LIMIT = 120;

/** Shortens a quote for display, the way a preview snippet works. */
function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** Cmd+Enter or Ctrl+Enter posts the draft on every platform. Enter alone adds a line. */
function submitOnModEnter(event: React.KeyboardEvent<HTMLTextAreaElement>) {
  if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
  event.preventDefault();
  event.currentTarget.form?.requestSubmit();
}

/**
 * Keeps the whole form in view while the reader types: the textarea, the hint
 * and the button. Typing only scrolls the caret into view, and focusing the
 * composer from a selection does not scroll at all.
 */
function revealForm(textarea: HTMLTextAreaElement) {
  textarea.form?.scrollIntoView({ block: "nearest" });
}

function SubmitHint({ id }: { id: string }) {
  const modifier = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
  return (
    <p id={id} className="hint submit-hint">
      <kbd>{modifier}</kbd> + <kbd>Enter</kbd> to post
    </p>
  );
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

/** How long the "marked as solved" notice offers its undo. */
const SOLVED_NOTICE_MS = 8000;

function countReplies(count: number): string {
  return count === 1 ? "1 reply" : `${count} replies`;
}

/**
 * The comment thread. Comments cannot be edited: the text and the time they
 * were written are the record. An author can delete their own after
 * confirming it. Anyone can mark a thread solved, which hides it until the
 * reader asks to see solved threads.
 *
 * Used inside the comments panel, which offers a pending selection and reacts
 * to a comment's quote being clicked.
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
  onShowSolvedChange,
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
  const [showSolved, setShowSolved] = useState(false);
  /** Solved threads opened to show their replies. */
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  /** The comment whose delete is waiting for confirmation. */
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  /** The thread just marked solved, offered for undo. */
  const [justSolved, setJustSolved] = useState<string | null>(null);

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

  useEffect(() => {
    onShowSolvedChange?.(showSolved);
  }, [showSolved, onShowSolvedChange]);

  useEffect(() => {
    if (!justSolved) return;
    const timer = window.setTimeout(() => setJustSolved(null), SOLVED_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [justSolved]);

  const threads = useMemo(() => threadComments(comments ?? []), [comments]);
  const solvedCount = threads.filter(({ root }) => root.solved).length;
  const openCount = threads.length - solvedCount;

  // A reply has no spot of its own to scroll or highlight: its thread's root
  // stands in for it.
  const focusedRootId = useMemo(() => {
    if (!focusedId) return null;
    const target = (comments ?? []).find((comment) => comment.id === focusedId);
    return target?.parentId ?? focusedId;
  }, [focusedId, comments]);

  // A link to a comment in a solved thread shows solved threads, opened.
  // Only a new focus does that: solving the focused thread must still hide it.
  const handledFocus = useRef<string | null>(null);
  useEffect(() => {
    if (focusedRootId === handledFocus.current) return;
    const focused = threads.find(({ root }) => root.id === focusedRootId);
    if (focusedRootId && !focused) return;
    handledFocus.current = focusedRootId;
    if (!focusedRootId || !focused?.root.solved) return;
    setShowSolved(true);
    setExpanded((current) => new Set(current).add(focusedRootId));
  }, [focusedRootId, threads]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: showing solved threads can bring the focused one on screen.
  useEffect(() => {
    if (!focusedRootId) return;
    document.getElementById(`comment-${focusedRootId}`)?.scrollIntoView({ block: "nearest" });
  }, [focusedRootId, showSolved]);

  useLiveEvents((event) => {
    if (
      event.type === "reconnected" ||
      (event.type === "comment.changed" && event.artifactId === artifactId)
    ) {
      void load();
    }
  });

  /** Puts a comment the server returned into the list, once. */
  function upsert(changed: Comment) {
    setComments((current) => {
      const listed = current ?? [];
      return listed.some((comment) => comment.id === changed.id)
        ? listed.map((comment) => (comment.id === changed.id ? changed : comment))
        : [...listed, changed];
    });
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (draft.trim() === "") {
      setProblem("Write something first.");
      return;
    }
    setSending(true);
    setProblem(null);
    try {
      // The announcement of this comment may have arrived first and brought
      // it back already, so it is put in the list only once.
      upsert(await addComment(artifactId, draft, { anchor, versionId }));
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
    setConfirmingDelete(null);
    try {
      await deleteComment(artifactId, id);
      setComments((current) =>
        (current ?? []).filter((comment) => comment.id !== id && comment.parentId !== id),
      );
    } catch (error) {
      setProblem(error instanceof ApiError ? error.message : "Could not delete that comment.");
    }
  }

  async function changeSolved(rootId: string, solved: boolean) {
    try {
      upsert(await setCommentSolved(artifactId, rootId, solved));
      setJustSolved(solved ? rootId : null);
    } catch (error) {
      setProblem(
        error instanceof ApiError
          ? error.message
          : solved
            ? "Could not mark that thread solved."
            : "Could not reopen that thread.",
      );
    }
  }

  function toggleExpanded(rootId: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(rootId)) next.add(rootId);
      return next;
    });
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
      upsert(created);
      // The server reopened the thread if it was solved.
      setComments((current) =>
        (current ?? []).map((comment) =>
          comment.id === rootId ? { ...comment, solved: null } : comment,
        ),
      );
      cancelReply();
    } catch (error) {
      setReplyProblem(error instanceof ApiError ? error.message : "Could not add that comment.");
    } finally {
      setReplySending(false);
    }
  }

  function deleteConfirmation(comment: Comment, replies: Comment[]) {
    const others = replies.filter((reply) => reply.author.id !== currentUserId).length;
    let question = "Delete this reply?";
    if (comment.parentId === null) {
      question =
        replies.length === 0
          ? "Delete this comment?"
          : `Delete this comment and ${countReplies(replies.length)}?`;
      if (others > 0) {
        question += ` ${others === 1 ? "One is" : `${others} are`} by someone else.`;
      }
    }
    return (
      <div className="delete-confirm">
        <p>{question}</p>
        <div className="reply-actions">
          <button type="button" className="danger" onClick={() => void remove(comment.id)}>
            Delete
          </button>
          <button type="button" className="link" onClick={() => setConfirmingDelete(null)}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  function meta(comment: Comment) {
    return (
      <p className="comment-meta">
        <MemberLink id={comment.author.id}>{comment.author.name}</MemberLink> ·{" "}
        <RelativeTime iso={comment.createdAt} />
        {viewedVersionNumber != null && comment.versionNumber !== viewedVersionNumber ? (
          <span className="badge version-badge">v{comment.versionNumber}</span>
        ) : null}
      </p>
    );
  }

  function replyForm(root: Comment) {
    return (
      <form className="reply-form" onSubmit={(event) => void submitReply(event, root.id)}>
        <label htmlFor={`reply-draft-${root.id}`}>Reply to {root.author.name}</label>
        <textarea
          id={`reply-draft-${root.id}`}
          rows={2}
          value={replyDraft}
          disabled={replySending}
          aria-describedby={`reply-hint-${root.id}`}
          onChange={(event) => {
            setReplyDraft(event.target.value);
            revealForm(event.target);
          }}
          onKeyDown={submitOnModEnter}
        />
        {root.solved ? <p className="hint">Posting a reply reopens the thread.</p> : null}
        <SubmitHint id={`reply-hint-${root.id}`} />
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
    );
  }

  function replyList(replies: Comment[]) {
    if (replies.length === 0) return null;
    return (
      <ul className="comment-replies">
        {replies.map((reply) => (
          <li key={reply.id} className="comment reply">
            {meta(reply)}
            <p className="comment-body">
              <CommentText text={reply.body} />
            </p>
            {reply.author.id === currentUserId ? (
              confirmingDelete === reply.id ? (
                deleteConfirmation(reply, [])
              ) : (
                <button
                  type="button"
                  className="link comment-delete"
                  onClick={() => setConfirmingDelete(reply.id)}
                >
                  Delete
                </button>
              )
            ) : null}
          </li>
        ))}
      </ul>
    );
  }

  function quote(root: Comment) {
    if (!root.anchor) return null;
    return (
      <button type="button" className="comment-quote" onClick={() => onFocusComment?.(root.id)}>
        {truncate(root.anchor.quote, QUOTE_PREVIEW_LIMIT)}
      </button>
    );
  }

  function openThread(root: Comment, replies: Comment[]) {
    return (
      <>
        <button
          type="button"
          className="icon-button icon-only comment-solve"
          onClick={() => void changeSolved(root.id, true)}
        >
          <CheckIcon />
          <span>Mark as solved</span>
        </button>
        {quote(root)}
        {meta(root)}
        <p className="comment-body">
          <CommentText text={root.body} />
        </p>
        {replyList(replies)}
        {replyingTo === root.id ? (
          replyForm(root)
        ) : (
          <div className="comment-actions">
            <button type="button" className="link" onClick={() => openReply(root.id)}>
              Reply
            </button>
            {root.author.id === currentUserId && confirmingDelete !== root.id ? (
              <button type="button" className="link" onClick={() => setConfirmingDelete(root.id)}>
                Delete
              </button>
            ) : null}
          </div>
        )}
        {confirmingDelete === root.id ? deleteConfirmation(root, replies) : null}
      </>
    );
  }

  function solvedThread(
    root: Comment & { solved: NonNullable<Comment["solved"]> },
    replies: Comment[],
  ) {
    const open = expanded.has(root.id) || replyingTo === root.id;
    return (
      <>
        <p className="comment-solved">
          <CheckIcon />
          <span>
            Solved by {root.solved.by.id === currentUserId ? "you" : root.solved.by.name} ·{" "}
            <RelativeTime iso={root.solved.at} />
          </span>
        </p>
        {quote(root)}
        {open ? (
          <>
            {meta(root)}
            <p className="comment-body">
              <CommentText text={root.body} />
            </p>
            {replyList(replies)}
          </>
        ) : (
          <p className="comment-body comment-summary">
            {root.author.name}: {root.body}
          </p>
        )}
        {replyingTo === root.id ? (
          replyForm(root)
        ) : (
          <div className="comment-actions">
            {replies.length > 0 ? (
              <button
                type="button"
                className="link"
                aria-expanded={open}
                onClick={() => toggleExpanded(root.id)}
              >
                {open ? "Hide replies" : `Show ${countReplies(replies.length)}`}
              </button>
            ) : null}
            <button type="button" className="link" onClick={() => openReply(root.id)}>
              Reply
            </button>
            <button
              type="button"
              className="link"
              onClick={() => void changeSolved(root.id, false)}
            >
              Reopen
            </button>
          </div>
        )}
      </>
    );
  }

  // A thread the reader is replying to stays on screen if someone else solves it.
  const shown = threads.filter(({ root }) => !root.solved || showSolved || root.id === replyingTo);

  return (
    <section className="comments">
      {heading ? <h2>Comments</h2> : null}

      {comments === null ? <p className="hint">Loading comments...</p> : null}
      {comments?.length === 0 ? <p className="hint">No comments yet.</p> : null}

      {solvedCount > 0 ? (
        <div className="comments-bar">
          <span>
            {openCount} open · {solvedCount} solved
          </span>
          <label className="solved-switch">
            <input
              type="checkbox"
              role="switch"
              aria-checked={showSolved}
              checked={showSolved}
              onChange={(event) => setShowSolved(event.target.checked)}
            />
            Show solved
          </label>
        </div>
      ) : null}

      {justSolved ? (
        <p className="comment-notice" role="status">
          Thread marked as solved.
          <button
            type="button"
            className="link"
            onClick={() => void changeSolved(justSolved, false)}
          >
            Undo
          </button>
        </p>
      ) : null}

      {threads.length > 0 && openCount === 0 && !showSolved ? (
        <p className="hint">All threads are solved.</p>
      ) : null}

      <ul>
        {shown.map(({ root, replies }) => {
          const classes = ["comment"];
          if (root.solved) classes.push("solved");
          if (root.id === focusedRootId) classes.push("focused");
          return (
            <li key={root.id} id={`comment-${root.id}`} className={classes.join(" ")}>
              {root.solved
                ? solvedThread({ ...root, solved: root.solved }, replies)
                : openThread(root, replies)}
            </li>
          );
        })}
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
          aria-describedby="comment-hint"
          onChange={(event) => {
            setDraft(event.target.value);
            revealForm(event.target);
          }}
          onKeyDown={submitOnModEnter}
        />
        <SubmitHint id="comment-hint" />
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
