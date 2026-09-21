import type { ArtifactVersion, Comment, CommentAnchor } from "./api.ts";
import { Comments } from "./Comments.tsx";
import { formatBytes } from "./format.ts";
import { CloseIcon } from "./Icons.tsx";
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
  onFocusComment: (id: string) => void;
  focusedId: string | null;
};

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
  onFocusComment,
  focusedId,
}: CommentsPanelProps) {
  const viewedId = viewedVersionId ?? currentVersionId;
  const viewedVersion = versions.find((version) => version.id === viewedId) ?? null;

  return (
    <aside
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
        <section className="versions" aria-label="Versions">
          <h3>Versions</h3>
          <ul>
            {versions.map((version) => {
              const isCurrent = version.id === currentVersionId;
              return (
                <li key={version.id}>
                  <button
                    type="button"
                    className={version.id === viewedId ? "version-row selected" : "version-row"}
                    aria-pressed={version.id === viewedId}
                    aria-label={`Version ${version.number}${isCurrent ? ", current" : ""}`}
                    onClick={() => onSelectVersion(version.id)}
                  >
                    <span className="version-number">v{version.number}</span>
                    {isCurrent ? <span className="badge">current</span> : null}
                    <span className="version-meta">
                      {version.creator.name} · <RelativeTime iso={version.createdAt} /> ·{" "}
                      {formatBytes(version.byteSize)}
                    </span>
                  </button>
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
    </aside>
  );
}
