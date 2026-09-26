import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArtifactPreview } from "./ArtifactPreview.tsx";
import { ArtifactText } from "./ArtifactText.tsx";
import {
  ApiError,
  type Artifact,
  type ArtifactVersion,
  type Comment,
  type CommentAnchor,
  clearEntry,
  type Entry,
  fetchArtifact,
  fetchVersions,
  setArtifactArchived,
  setArtifactStatus,
  setEntry,
  sourceUrl,
} from "./api.ts";
import { CommentsPanel } from "./CommentsPanel.tsx";
import { formatBytes } from "./format.ts";
import {
  ArchiveIcon,
  CheckIcon,
  CommentIcon,
  DownloadIcon,
  FolderIcon,
  LinkIcon,
  PreviewIcon,
  ReopenIcon,
  RestoreIcon,
  TagIcon,
  TextIcon,
} from "./Icons.tsx";
import { useLiveEvents } from "./live.ts";
import { Masthead } from "./Masthead.tsx";
import { FolderPicker, TagPicker } from "./Organize.tsx";
import {
  type BridgeMessage,
  lastPageInput,
  openFromPreview,
  type PageEntry,
  readerClickState,
  type SelectionRect,
  sendToPreview,
  usePreviewBridge,
} from "./preview-bridge.ts";
import { RelativeTime } from "./RelativeTime.tsx";
import { artifactPath } from "./router.ts";

export type ArtifactFullProps = {
  id: string;
  email: string;
  currentUserId: string;
  onHome: () => void;
  onSignOut: () => void;
};

type HeaderAction = {
  id: string;
  label: string;
  icon: ReactNode;
  onSelect?: () => void;
  /** Present on the one action that is a link and not a button. */
  download?: { href: string; filename: string };
  disabled?: boolean;
  pressed?: boolean;
  expanded?: boolean;
  keepsMenuOpen?: boolean;
  /** Puts a dot on the header button, e.g. when the artifact has tags. */
  dot?: boolean;
};

function HeaderControl({
  action,
  className,
  onDone,
}: {
  action: HeaderAction;
  className: string;
  onDone?: () => void;
}) {
  if (action.download) {
    return (
      <a
        className={`button ${className}`}
        href={action.download.href}
        download={action.download.filename}
        onClick={onDone}
      >
        {action.icon}
        <span>{action.label}</span>
      </a>
    );
  }
  return (
    <button
      type="button"
      className={className}
      disabled={action.disabled}
      aria-pressed={action.pressed}
      aria-expanded={action.expanded}
      data-dot={action.dot || undefined}
      onClick={() => {
        action.onSelect?.();
        onDone?.();
      }}
    >
      {action.icon}
      <span>{action.label}</span>
    </button>
  );
}

/**
 * One artifact filling everything below the masthead, which carries the
 * artifact's name, its metadata and the actions on it. The frame scrolls its
 * own document, so the header stays in place while the artifact moves.
 */
export function ArtifactFull({ id, email, currentUserId, onHome, onSignOut }: ArtifactFullProps) {
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"preview" | "text">("preview");
  const [copied, setCopied] = useState(false);
  const [changing, setChanging] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [organizing, setOrganizing] = useState<"tags" | "folder" | null>(null);
  const [selection, setSelection] = useState<CommentAnchor | null>(null);
  /** What is selected in the artifact right now, and where, for the overlay. */
  const [live, setLive] = useState<{ anchor: CommentAnchor; rect: SelectionRect } | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  /** The entry the artifact just recorded for the reader, shown for a moment. */
  const [recorded, setRecorded] = useState<string | null>(null);
  const [versions, setVersions] = useState<ArtifactVersion[]>([]);
  /** The version being viewed. Null means the current version. */
  const [viewedVersionId, setViewedVersionId] = useState<string | null>(null);
  const request = useRef(0);
  const versionsRequest = useRef(0);
  const shown = useRef(false);
  const frameRef = useRef<HTMLIFrameElement>(null);

  // The viewed version's id, resolved against the current one when nothing
  // specific is being viewed.
  const viewedId = viewedVersionId ?? artifact?.currentVersionId ?? null;

  // A reload may have dropped the version being viewed, e.g. because it was
  // an artifact that no longer exists under this id. Falling back to the
  // current version is the only sensible thing left to show.
  useEffect(() => {
    if (viewedVersionId === null || versions.length === 0) return;
    if (!versions.some((version) => version.id === viewedVersionId)) setViewedVersionId(null);
  }, [versions, viewedVersionId]);

  const viewedVersion = versions.find((version) => version.id === viewedId) ?? null;

  const highlights = useMemo(
    () =>
      comments
        .filter((comment): comment is Comment & { anchor: CommentAnchor } => comment.anchor != null)
        .map(({ id: commentId, anchor }) => ({ id: commentId, ...anchor })),
    [comments],
  );

  const pageComments = useMemo(
    () =>
      comments.map((comment) => ({
        id: comment.id,
        body: comment.body,
        author: comment.author.name,
        createdAt: comment.createdAt,
        anchor: comment.anchor,
        parentId: comment.parentId,
        versionNumber: comment.versionNumber,
      })),
    [comments],
  );

  const pageEntries = useMemo(
    (): PageEntry[] =>
      entries.map((entry) => ({
        key: entry.key,
        value: entry.value,
        authorId: entry.author.id,
        author: entry.author.name,
        updatedAt: entry.updatedAt,
      })),
    [entries],
  );

  // The artifact asks to change the reader's own entries. Only a request made
  // during the reader's click inside the frame goes through, so a page cannot
  // write as whoever opens it; the change comes back as the next entries update.
  const changeEntry = useCallback(
    async (key: string, change: { value: unknown } | null) => {
      if (!artifact) return;
      try {
        if (change) await setEntry(artifact.id, key, change.value);
        else await clearEntry(artifact.id, key);
        setRecorded(change ? `Saved ${key}` : `Removed ${key}`);
      } catch (error) {
        setProblem(error instanceof ApiError ? error.message : "Could not save that entry.");
      }
    },
    [artifact],
  );

  useEffect(() => {
    if (!recorded) return;
    const timer = window.setTimeout(() => setRecorded(null), 4000);
    return () => window.clearTimeout(timer);
  }, [recorded]);

  const handleBridgeMessage = useCallback(
    (message: BridgeMessage) => {
      if (message.type === "ready") {
        // The frame just loaded (or reloaded), so it knows nothing yet.
        sendToPreview(frameRef.current, { type: "mode", enabled: panelOpen });
        sendToPreview(frameRef.current, { type: "highlights", anchors: highlights });
        sendToPreview(frameRef.current, { type: "comments", comments: pageComments });
        sendToPreview(frameRef.current, { type: "entries", entries: pageEntries });
      } else if (message.type === "selection") {
        setLive(
          message.anchor && message.rect ? { anchor: message.anchor, rect: message.rect } : null,
        );
        if (panelOpen) setSelection(message.anchor);
      } else if (message.type === "open") {
        openFromPreview(message.url);
      } else if (message.type === "set" || message.type === "clear") {
        const state = readerClickState(lastPageInput());
        if (state === "clicked") {
          void changeEntry(message.key, message.type === "set" ? { value: message.value } : null);
        } else if (state === "too-soon" && document.activeElement === frameRef.current) {
          // Probably a real click, too soon after one on this page to tell apart.
          setRecorded("Not saved. Click again in a moment.");
        }
      } else {
        setFocusedId(message.id);
        setPanelOpen(true);
      }
    },
    [panelOpen, highlights, pageComments, pageEntries, changeEntry],
  );

  usePreviewBridge(frameRef, handleBridgeMessage);

  useEffect(() => {
    sendToPreview(frameRef.current, { type: "mode", enabled: panelOpen });
    if (!panelOpen) setSelection(null);
  }, [panelOpen]);

  useEffect(() => {
    sendToPreview(frameRef.current, { type: "highlights", anchors: highlights });
  }, [highlights]);

  useEffect(() => {
    sendToPreview(frameRef.current, { type: "comments", comments: pageComments });
  }, [pageComments]);

  useEffect(() => {
    sendToPreview(frameRef.current, { type: "entries", entries: pageEntries });
  }, [pageEntries]);

  // Takes the selection into the composer, like the comment control in the
  // margin of a document. The panel opens if it was closed.
  function commentOnSelection() {
    if (!live) return;
    setSelection(live.anchor);
    setPanelOpen(true);
    setLive(null);
    // Focusing scrolls the nearest scroll container to the element, and the
    // composer is still off to the side while the panel slides in. That would
    // drag the artifact along and snap it back a moment later.
    window.requestAnimationFrame(() =>
      document.getElementById("comment-draft")?.focus({ preventScroll: true }),
    );
  }

  const revealComment = useCallback((commentId: string) => {
    sendToPreview(frameRef.current, { type: "reveal", id: commentId });
    setFocusedId(commentId);
  }, []);

  const load = useCallback(async () => {
    const attempt = ++request.current;
    try {
      const found = await fetchArtifact(id);
      // A slower earlier request must not overwrite a later one.
      if (attempt !== request.current) return;
      shown.current = true;
      setArtifact(found);
    } catch (cause) {
      if (attempt !== request.current) return;
      // A background reload that fails leaves the artifact on screen.
      if (shown.current) return;
      setError(cause instanceof ApiError ? cause.message : "Could not load the artifact.");
    }
  }, [id]);

  const loadVersions = useCallback(async () => {
    const attempt = ++versionsRequest.current;
    try {
      const found = await fetchVersions(id);
      if (attempt !== versionsRequest.current) return;
      setVersions(found);
    } catch {
      // The version list is supplementary; a failure here leaves the artifact
      // itself, and whatever version was being viewed, on screen.
    }
  }, [id]);

  useEffect(() => {
    void load();
    void loadVersions();
  }, [load, loadVersions]);

  useLiveEvents((event) => {
    // The reader's own change is already on its way back with the new artifact.
    if (changing) return;
    if (event.type === "reconnected" || (event.type === "artifact.changed" && event.id === id)) {
      void load();
      void loadVersions();
    }
  });

  // The tab has no heading to read, so its name is the only label it gets.
  useEffect(() => {
    if (!artifact) return;
    const previous = document.title;
    document.title = artifact.title;
    return () => {
      document.title = previous;
    };
  }, [artifact]);

  async function change(action: () => Promise<Artifact>) {
    setChanging(true);
    setProblem(null);
    try {
      setArtifact(await action());
    } catch (cause) {
      setProblem(cause instanceof ApiError ? cause.message : "That change did not go through.");
    } finally {
      setChanging(false);
    }
  }

  async function copyLink() {
    const link = new URL(artifactPath(id), window.location.origin).toString();
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copy this link", link);
    }
  }

  const actions: HeaderAction[] = artifact
    ? [
        {
          id: "copy",
          label: copied ? "Link copied" : "Copy link",
          icon: <LinkIcon />,
          onSelect: () => void copyLink(),
          keepsMenuOpen: true,
        },
        {
          id: "status",
          label: artifact.status === "solved" ? "Reopen" : "Mark solved",
          icon: artifact.status === "solved" ? <ReopenIcon /> : <CheckIcon />,
          disabled: changing,
          onSelect: () =>
            void change(() =>
              setArtifactStatus(artifact.id, artifact.status === "solved" ? "open" : "solved"),
            ),
        },
        {
          id: "archive",
          label: artifact.archivedAt ? "Restore" : "Archive",
          icon: artifact.archivedAt ? <RestoreIcon /> : <ArchiveIcon />,
          disabled: changing,
          onSelect: () => void change(() => setArtifactArchived(artifact.id, !artifact.archivedAt)),
        },
        {
          id: "download",
          label: "Download source",
          icon: <DownloadIcon />,
          download: {
            href: sourceUrl(artifact.id, viewedVersionId),
            filename: viewedVersion?.originalFilename ?? artifact.originalFilename,
          },
        },
        {
          id: "view",
          label: view === "text" ? "View preview" : "View markdown",
          icon: view === "text" ? <PreviewIcon /> : <TextIcon />,
          pressed: view === "text",
          onSelect: () => setView(view === "text" ? "preview" : "text"),
        },
        {
          id: "tags",
          label: "Tags",
          icon: <TagIcon />,
          pressed: organizing === "tags",
          expanded: organizing === "tags",
          dot: artifact.tags.length > 0,
          onSelect: () => setOrganizing(organizing === "tags" ? null : "tags"),
        },
        {
          id: "folder",
          label: "Move to folder",
          icon: <FolderIcon />,
          pressed: organizing === "folder",
          expanded: organizing === "folder",
          onSelect: () => setOrganizing(organizing === "folder" ? null : "folder"),
        },
      ]
    : [];

  const closeOrganizing = useCallback(() => setOrganizing(null), []);

  const commentsAction: HeaderAction = {
    id: "comments",
    label: "Versions & comments",
    icon: <CommentIcon />,
    pressed: panelOpen,
    expanded: panelOpen,
    onSelect: () => setPanelOpen((open) => !open),
  };

  const header = artifact ? (
    <div className="full-header">
      <div className="full-title">
        <h1 title={artifact.title}>
          {artifact.title}
          {artifact.status === "solved" ? <span className="badge solved">solved</span> : null}
          {artifact.archivedAt ? <span className="badge">archived</span> : null}
        </h1>
        <p className="detail-meta">
          {artifact.creator.name} · <RelativeTime iso={artifact.createdAt} />
          <span className="meta-extra">
            {" "}
            · {formatBytes(artifact.byteSize)} ·{" "}
            <span className="filename">{artifact.originalFilename}</span>
          </span>
        </p>
      </div>
      <div className="full-actions">
        {actions.map((action) => (
          <HeaderControl key={action.id} action={action} className="icon-button icon-only" />
        ))}
      </div>
      {organizing === "tags" ? (
        <TagPicker artifact={artifact} onChanged={setArtifact} onClose={closeOrganizing} />
      ) : null}
      {organizing === "folder" ? (
        <FolderPicker artifact={artifact} onChanged={setArtifact} onClose={closeOrganizing} />
      ) : null}
      {problem ? (
        <p className="problem" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  ) : null;

  const commentsToggle = artifact ? (
    <HeaderControl action={commentsAction} className="icon-button icon-only" />
  ) : null;

  const menu = artifact
    ? (close: () => void) =>
        [...actions, commentsAction].map((action) => (
          <HeaderControl
            key={action.id}
            action={action}
            className="menu-row"
            onDone={action.keepsMenuOpen ? undefined : close}
          />
        ))
    : undefined;

  let body: ReactNode;
  if (error) {
    body = (
      <main className="shell">
        <p role="alert">{error}</p>
      </main>
    );
  } else if (!artifact) {
    body = (
      <main className="shell">
        <p className="hint">Loading...</p>
      </main>
    );
  } else if (view === "text") {
    body = (
      <main className="full-text">
        <ArtifactText artifactId={artifact.id} versionId={viewedVersionId} />
      </main>
    );
  } else {
    body = (
      <ArtifactPreview
        ref={frameRef}
        artifactId={artifact.id}
        title={artifact.title}
        className="preview-full"
        versionId={viewedVersionId}
      />
    );
  }

  // The rectangle is relative to the frame's viewport, which is the frame's
  // box on this page. The control sits at the selection's top right corner,
  // kept inside the frame.
  const frameBox = frameRef.current?.getBoundingClientRect();
  const overlay =
    live && view === "preview" && frameBox ? (
      <button
        type="button"
        className="selection-overlay"
        aria-label="Comment on selection"
        title="Comment on selection"
        style={{
          top: Math.min(
            Math.max(frameBox.top + live.rect.top - 8, frameBox.top),
            frameBox.bottom - 40,
          ),
          left: Math.min(
            Math.max(frameBox.left + live.rect.right + 8, frameBox.left),
            frameBox.right - 40,
          ),
        }}
        onClick={commentOnSelection}
      >
        <CommentIcon />
      </button>
    ) : null;

  return (
    <div className="full">
      <Masthead
        email={email}
        onHome={onHome}
        onSignOut={onSignOut}
        trailing={commentsToggle}
        menu={menu}
      >
        {header}
      </Masthead>
      <div className="full-body">
        {body}
        {overlay}
        {recorded ? (
          <p className="recorded-notice" role="status">
            {recorded}
          </p>
        ) : null}
        {artifact ? (
          <CommentsPanel
            open={panelOpen}
            artifactId={artifact.id}
            currentUserId={currentUserId}
            versions={versions}
            currentVersionId={artifact.currentVersionId}
            viewedVersionId={viewedVersionId}
            onSelectVersion={setViewedVersionId}
            anchor={selection}
            onClearAnchor={() => setSelection(null)}
            onClose={() => setPanelOpen(false)}
            onComments={setComments}
            onEntries={setEntries}
            onFocusComment={revealComment}
            focusedId={focusedId}
          />
        ) : null}
      </div>
    </div>
  );
}
