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
  setArtifactVisibility,
  setEntry,
  sourceUrl,
} from "./api.ts";
import { CommentsPanel } from "./CommentsPanel.tsx";
import { formatBytes } from "./format.ts";
import {
  ArchiveIcon,
  CheckIcon,
  ChevronRightIcon,
  CommentIcon,
  DownloadIcon,
  EyeIcon,
  FolderIcon,
  LinkIcon,
  LockIcon,
  PreviewIcon,
  ReopenIcon,
  RestoreIcon,
  SearchIcon,
  TagIcon,
  TextIcon,
  UnlockIcon,
} from "./Icons.tsx";
import { useLiveEvents } from "./live.ts";
import { Masthead } from "./Masthead.tsx";
import { MemberLink } from "./Member.tsx";
import { FolderPicker, TagPicker } from "./Organize.tsx";
import {
  type BridgeMessage,
  openFromPreview,
  type PageEntry,
  readerIsActing,
  type SelectionRect,
  sendToPreview,
  showFragment,
  usePreviewBridge,
} from "./preview-bridge.ts";
import { RelativeTime } from "./RelativeTime.tsx";
import { type ArtifactTarget, artifactPath, type GalleryFilters } from "./router.ts";
import { type FindResult, SearchPopover, useSearchShortcut } from "./Search.tsx";
import { effectiveLevel, useSubscription, WatchPopover, watchLabel } from "./Watch.tsx";

export type ArtifactFullProps = {
  id: string;
  email: string;
  /** The URL of the user's avatar, or null for their initial. */
  avatar: string | null;
  currentUserId: string;
  /** False when the deployment has no private artifacts. */
  privateArtifacts: boolean;
  onHome: () => void;
  onOpenFolder: (folderId: string) => void;
  /** Shows the gallery with these filters, e.g. all results of a search. */
  onOpenGallery: (filters: Partial<GalleryFilters>) => void;
  onProfile: () => void;
  onOpenArtifact: (id: string, target?: ArtifactTarget) => void;
  /** A version to open the panel on, e.g. from a notification. */
  versionId?: string | null;
  /** A comment to open the panel on and reveal in the artifact. */
  commentId?: string | null;
  /** Text to find in the artifact once it shows. */
  find?: string | null;
  /** Called once the page has acted on `versionId`, `commentId`, or `find`, so the link can be dropped. */
  onLinkShown?: () => void;
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
  /** Colours the header button, e.g. while the reader watches the artifact. */
  active?: boolean;
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
      data-active={action.active || undefined}
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
export function ArtifactFull({
  id,
  email,
  avatar,
  currentUserId,
  privateArtifacts,
  onHome,
  onOpenFolder,
  onOpenGallery,
  onProfile,
  onOpenArtifact,
  versionId = null,
  commentId = null,
  find = null,
  onLinkShown,
}: ArtifactFullProps) {
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Someone else's private artifact, of which the page shows nothing. */
  const [hidden, setHidden] = useState(false);
  const [view, setView] = useState<"preview" | "text">("preview");
  const [copied, setCopied] = useState(false);
  const [changing, setChanging] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [organizing, setOrganizing] = useState<"tags" | "folder" | "watch" | "search" | null>(null);
  const [selection, setSelection] = useState<CommentAnchor | null>(null);
  /** What is selected in the artifact right now, and where, for the overlay. */
  const [live, setLive] = useState<{ anchor: CommentAnchor; rect: SelectionRect } | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  /** The entry the artifact just recorded for the reader, shown for a moment. */
  const [recorded, setRecorded] = useState<string | null>(null);
  /** A version or comment added from somewhere other than this page, shown for a moment. */
  const [notice, setNotice] = useState<{ message: string; commentId?: string } | null>(null);
  // What the reader has already seen. Null until the first load, which
  // announces nothing.
  const newestVersion = useRef<number | null>(null);
  const knownComments = useRef<Set<string> | null>(null);
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

  /** A comment from a link, waiting to be revealed in the artifact. */
  const [pendingReveal, setPendingReveal] = useState<string | null>(null);
  const [frameReady, setFrameReady] = useState(false);
  /** How many matches the frame found for the reader's find, and which is current. */
  const [found, setFound] = useState<FindResult | null>(null);
  /** Text from a link, waiting for the artifact to show before it is found. */
  const [pendingFind, setPendingFind] = useState<string | null>(null);
  /**
   * What the search popover opens with, when a link asked for a find. The
   * number remounts an open popover for a second find.
   */
  const [initialFind, setInitialFind] = useState<{ query: string; key: number } | null>(null);

  const linkShown = useRef(onLinkShown);
  useEffect(() => {
    linkShown.current = onLinkShown;
  });

  useEffect(() => {
    if (!find) return;
    setPendingFind(find);
    linkShown.current?.();
  }, [find]);

  useEffect(() => {
    if (!versionId && !commentId) return;
    if (versionId) setViewedVersionId(versionId);
    if (commentId) {
      setFocusedId(commentId);
      setPendingReveal(commentId);
    }
    setPanelOpen(true);
    linkShown.current?.();
  }, [versionId, commentId]);

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

  // The change reaches the page as the next entries update.
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

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const handleComments = useCallback(
    (list: Comment[]) => {
      setComments(list);
      const known = knownComments.current;
      knownComments.current = new Set(list.map((comment) => comment.id));
      if (!known) return;
      // The reader's agent writes as the reader, so a comment of theirs is
      // news unless they wrote it in the web app.
      const fresh = list.filter(
        (comment) =>
          !known.has(comment.id) && !(comment.inApp && comment.author.id === currentUserId),
      );
      const [first] = fresh;
      if (!first) return;
      setNotice({
        message:
          fresh.length > 1 ? `${fresh.length} new comments` : `${first.author.name} commented`,
        commentId: first.id,
      });
    },
    [currentUserId],
  );

  const handleBridgeMessage = useCallback(
    (message: BridgeMessage) => {
      if (message.type === "ready") {
        // The frame just loaded (or reloaded), so it knows nothing yet.
        setFrameReady(true);
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
      } else if (message.type === "hash") {
        showFragment(message.hash);
      } else if (message.type === "set" || message.type === "clear") {
        if (!readerIsActing()) return;
        void changeEntry(message.key, message.type === "set" ? { value: message.value } : null);
      } else if (message.type === "found") {
        setFound({ count: message.count, index: message.index, more: message.more });
      } else {
        setFocusedId(message.id);
        setPanelOpen(true);
      }
    },
    [panelOpen, highlights, pageComments, pageEntries, changeEntry],
  );

  usePreviewBridge(frameRef, handleBridgeMessage);

  const runFind = useCallback((query: string, index: number) => {
    if (query.trim() === "") setFound(null);
    sendToPreview(frameRef.current, { type: "find", query, index });
  }, []);

  useEffect(() => {
    sendToPreview(frameRef.current, { type: "mode", enabled: panelOpen });
    if (!panelOpen) setSelection(null);
  }, [panelOpen]);

  useEffect(() => {
    sendToPreview(frameRef.current, { type: "highlights", anchors: highlights });
  }, [highlights]);

  // After the highlights above, so the frame knows the passage by the time it
  // is asked to reveal it.
  useEffect(() => {
    if (!pendingReveal || !frameReady) return;
    if (!comments.some((comment) => comment.id === pendingReveal)) return;
    sendToPreview(frameRef.current, { type: "reveal", id: pendingReveal });
    setPendingReveal(null);
  }, [pendingReveal, frameReady, comments]);

  // The popover finds in the frame, so a link's find waits until the frame can answer.
  useEffect(() => {
    if (!pendingFind || !frameReady || view !== "preview") return;
    setInitialFind((previous) => ({ query: pendingFind, key: (previous?.key ?? 0) + 1 }));
    setOrganizing("search");
    setPendingFind(null);
  }, [pendingFind, frameReady, view]);

  useEffect(() => {
    if (organizing !== "search") setInitialFind(null);
  }, [organizing]);

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

  // The versions are the first section of the panel, so its top shows them.
  function showVersions() {
    setPanelOpen(true);
    // No scrolling into view while the panel slides in, as in commentOnSelection.
    window.requestAnimationFrame(() => {
      const section = document.getElementById("versions");
      if (section?.parentElement) section.parentElement.scrollTop = 0;
      section
        ?.querySelector<HTMLElement>(".version-row.selected .version-select")
        ?.focus({ preventScroll: true });
    });
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
      setHidden(false);
      setArtifact(found);
    } catch (cause) {
      if (attempt !== request.current) return;
      // Its creator made it private while it was open here.
      if (cause instanceof ApiError && cause.code === "PRIVATE") {
        setArtifact(null);
        setHidden(true);
        return;
      }
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
      // The list comes highest first.
      const newest = found[0];
      if (newest) {
        const seen = newestVersion.current;
        const mine = newest.inApp && newest.creator.id === currentUserId;
        if (seen !== null && newest.number > seen && !mine) {
          setNotice({ message: `${newest.creator.name} uploaded version ${newest.number}` });
        }
        newestVersion.current = Math.max(seen ?? 0, newest.number);
      }
    } catch {
      // The version list is supplementary; a failure here leaves the artifact
      // itself, and whatever version was being viewed, on screen.
    }
  }, [id, currentUserId]);

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
    const link = new URL(
      artifactPath(id) + window.location.hash,
      window.location.origin,
    ).toString();
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copy this link", link);
    }
  }

  // Commenting or uploading a version can follow the artifact again, and
  // moving it changes the folder it inherits a level from.
  const { subscription, choose: chooseLevel } = useSubscription(
    artifact ? { kind: "artifacts", id: artifact.id } : null,
    `${artifact?.folder?.id}:${comments.length}:${versions.length}`,
  );
  const watching = effectiveLevel(subscription);

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
        ...(privateArtifacts && artifact.creator.id === currentUserId
          ? [
              {
                id: "visibility",
                label: artifact.visibility === "private" ? "Share with everyone" : "Make private",
                icon: artifact.visibility === "private" ? <UnlockIcon /> : <LockIcon />,
                disabled: changing,
                onSelect: () =>
                  void change(() =>
                    setArtifactVisibility(
                      artifact.id,
                      artifact.visibility === "private" ? "shared" : "private",
                    ),
                  ),
              },
            ]
          : []),
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
        {
          id: "watch",
          label: watchLabel(watching),
          icon: <EyeIcon />,
          pressed: organizing === "watch",
          expanded: organizing === "watch",
          active: watching !== "none",
          onSelect: () => setOrganizing(organizing === "watch" ? null : "watch"),
        },
      ]
    : [];

  const closeOrganizing = useCallback(() => setOrganizing(null), []);
  useSearchShortcut(() => {
    if (artifact) setOrganizing("search");
  });

  const commentsAction: HeaderAction = {
    id: "comments",
    label: "Versions & comments",
    icon: <CommentIcon />,
    pressed: panelOpen,
    expanded: panelOpen,
    onSelect: () => setPanelOpen((open) => !open),
  };

  const searchAction: HeaderAction = {
    id: "search",
    label: "Search",
    icon: <SearchIcon />,
    pressed: organizing === "search",
    expanded: organizing === "search",
    onSelect: () => setOrganizing(organizing === "search" ? null : "search"),
  };

  const header = artifact ? (
    <div className="full-header">
      <div className="full-title">
        <div className="full-name">
          {artifact.folder ? (
            <>
              <button
                type="button"
                className="icon-button icon-only folder-link"
                onClick={() => artifact.folder && onOpenFolder(artifact.folder.id)}
              >
                <FolderIcon size={20} />
                <span>Open folder {artifact.folder.name}</span>
              </button>
              <ChevronRightIcon />
            </>
          ) : null}
          <h1 title={artifact.title}>
            {artifact.title}
            {artifact.status === "solved" ? <span className="badge solved">solved</span> : null}
            {artifact.archivedAt ? <span className="badge">archived</span> : null}
            {artifact.visibility === "private" ? <span className="badge">private</span> : null}
          </h1>
          {viewedVersion && versions.length > 1 ? (
            <button
              type="button"
              className="version-pill"
              aria-label={`Show versions, viewing version ${viewedVersion.number}`}
              title="Show versions"
              onClick={showVersions}
            >
              v{viewedVersion.number}
            </button>
          ) : null}
        </div>
        <p className="detail-meta">
          <MemberLink id={artifact.creator.id}>{artifact.creator.name}</MemberLink> ·{" "}
          <RelativeTime iso={artifact.createdAt} />
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
        <span className="full-actions-divider" aria-hidden="true" />
        <HeaderControl action={commentsAction} className="icon-button icon-only" />
        <HeaderControl action={searchAction} className="icon-button icon-only" />
      </div>
      {organizing === "tags" ? (
        <TagPicker artifacts={[artifact]} onChanged={setArtifact} onClose={closeOrganizing} />
      ) : null}
      {organizing === "folder" ? (
        <FolderPicker artifacts={[artifact]} onChanged={setArtifact} onClose={closeOrganizing} />
      ) : null}
      {organizing === "watch" ? (
        <WatchPopover
          label="Watch"
          subscription={subscription}
          onChoose={chooseLevel}
          onClose={closeOrganizing}
        />
      ) : null}
      {organizing === "search" ? (
        <SearchPopover
          key={initialFind?.key ?? 0}
          initialQuery={initialFind?.query ?? ""}
          initialScope={initialFind ? "artifact" : "everywhere"}
          folderId={artifact.folder?.id ?? null}
          // The markdown view is part of this page, where the browser's own find works.
          find={view === "preview" && frameReady ? { result: found, run: runFind } : null}
          onOpenArtifact={onOpenArtifact}
          onOpenGallery={onOpenGallery}
          onClose={closeOrganizing}
        />
      ) : null}
      {problem ? (
        <p className="problem" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  ) : null;

  const menu = artifact
    ? (close: () => void) =>
        [...actions, commentsAction, searchAction].map((action) => (
          <HeaderControl
            key={action.id}
            action={action}
            className="menu-row"
            onDone={action.keepsMenuOpen ? undefined : close}
          />
        ))
    : undefined;

  let body: ReactNode;
  if (hidden) {
    body = (
      <main className="shell">
        <section className="empty">
          <p>This artifact is private.</p>
          <button type="button" onClick={onHome}>
            Back to the gallery
          </button>
        </section>
      </main>
    );
  } else if (error) {
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
        avatar={avatar}
        onHome={onHome}
        onProfile={onProfile}
        onOpenArtifact={onOpenArtifact}
        menu={menu}
        notice={
          notice
            ? {
                message: notice.message,
                onSelect: () => {
                  setNotice(null);
                  setPanelOpen(true);
                  if (notice.commentId) revealComment(notice.commentId);
                  // A new version is the current one.
                  else setViewedVersionId(null);
                },
              }
            : null
        }
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
            onComments={handleComments}
            onEntries={setEntries}
            onFocusComment={revealComment}
            focusedId={focusedId}
          />
        ) : null}
      </div>
    </div>
  );
}
