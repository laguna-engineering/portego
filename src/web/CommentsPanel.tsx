import { useEffect, useRef } from "react";
import type { ArtifactVersion, Comment, CommentAnchor, Entry } from "./api.ts";
import { Comments } from "./Comments.tsx";
import { Entries } from "./Entries.tsx";
import { formatBytes } from "./format.ts";
import { CloseIcon } from "./Icons.tsx";
import { MemberLink } from "./Member.tsx";
import { RelativeTime } from "./RelativeTime.tsx";

export type CommentsPanelProps = {
  open: boolean;
  artifactId: string;
  currentUserId: string;
  /** Every version of the artifact, highest number (the current one) first. */
  versions: ArtifactVersion[];
  /** The artifact's current version id, to mark the row that carries it. */
  currentVersionId: string;
  /** The version being viewed. Null means the current version. */
  viewedVersionId: string | null;
  onSelectVersion: (id: string) => void;
  anchor: CommentAnchor | null;
  onClearAnchor: () => void;
  onClose: () => void;
  onComments: (comments: Comment[]) => void;
  onEntries: (entries: Entry[]) => void;
  onFocusComment: (id: string) => void;
  focusedId: string | null;
};

export const COMMENTS_PANEL_ID = "comments-panel";

/**
 * Clicks here leave the panel open. Controls that open the panel carry
 * aria-controls, so the press does not close it before its click opens it
 * again. A click that dismisses a popover or the menu dismisses only that.
 */
const KEEPS_PANEL_OPEN = [
  `#${COMMENTS_PANEL_ID}`,
  `[aria-controls="${COMMENTS_PANEL_ID}"]`,
  ".popover",
  ".popover-backdrop",
  ".masthead-menu",
  ".masthead-menu-backdrop",
  ".masthead-notices",
].join(", ");

/**
 * The comment thread, and the version history above it, as a panel over the
 * full-screen artifact, like Google Docs: it slides in from the right without
 * leaving the page, so a reader can select a passage in the artifact and
 * discuss it without losing their place. It stays mounted while closed so the
 * slide has something to animate and the thread (and its highlights) are
 * already loaded the moment it opens.
 */
export function CommentsPanel({
  open,
  artifactId,
  currentUserId,
  versions,
  currentVersionId,
  viewedVersionId,
  onSelectVersion,
  anchor,
  onClearAnchor,
  onClose,
  onComments,
  onEntries,
  onFocusComment,
  focusedId,
}: CommentsPanelProps) {
  const panel = useRef<HTMLElement>(null);

  // Clicks inside the artifact's frame never reach this document, so selecting
  // a passage to comment on keeps the panel open.
  useEffect(() => {
    if (!open) return;
    const close = () => {
      // The closed panel is only moved off screen, so focus left in it would
      // keep typing into a hidden field.
      if (panel.current?.contains(document.activeElement)) {
        (document.activeElement as HTMLElement).blur();
      }
      onClose();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(KEEPS_PANEL_OPEN)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Escape closes the topmost layer only: a popover, the menu, or the
      // notifications close first. This listener captures on the window, so
      // it sees those layers before their own handlers close them.
      const otherLayer = document.querySelector(
        `[aria-expanded="true"]:not([aria-controls="${COMMENTS_PANEL_ID}"])`,
      );
      if (!otherLayer) close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, onClose]);

  const viewedId = viewedVersionId ?? currentVersionId;
  const viewedVersion = versions.find((version) => version.id === viewedId) ?? null;

  return (
    <aside
      ref={panel}
      id={COMMENTS_PANEL_ID}
      className={open ? "comments-panel open" : "comments-panel"}
      role="dialog"
      aria-label="Versions and comments"
    >
      <div className="comments-panel-header">
        <h2>Versions & comments</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close comments">
          <CloseIcon />
        </button>
      </div>

      {versions.length > 0 ? (
        <section id="versions" className="versions" aria-label="Versions">
          <h3>Versions</h3>
          <ul>
            {versions.map((version) => {
              const isCurrent = version.id === currentVersionId;
              return (
                <li
                  key={version.id}
                  className={version.id === viewedId ? "version-row selected" : "version-row"}
                >
                  <button
                    type="button"
                    className="row-button version-select"
                    aria-pressed={version.id === viewedId}
                    aria-label={`Version ${version.number}${isCurrent ? ", current" : ""}`}
                    onClick={() => onSelectVersion(version.id)}
                  >
                    <span className="version-number">v{version.number}</span>
                    {isCurrent ? <span className="badge">current</span> : null}
                  </button>
                  <span className="version-meta">
                    <MemberLink id={version.creator.id}>{version.creator.name}</MemberLink> ·{" "}
                    <RelativeTime iso={version.createdAt} /> · {formatBytes(version.byteSize)}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <p className="hint">Select text in the artifact to comment on it.</p>
      <Comments
        artifactId={artifactId}
        currentUserId={currentUserId}
        anchor={anchor}
        onClearAnchor={onClearAnchor}
        onFocusComment={onFocusComment}
        focusedId={focusedId}
        onComments={onComments}
        heading={false}
        versionId={viewedId}
        viewedVersionNumber={viewedVersion?.number ?? null}
      />
      <Entries artifactId={artifactId} currentUserId={currentUserId} onEntries={onEntries} />
    </aside>
  );
}
