import {
  type DragEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { ARTIFACT_DRAG_TYPE } from "./ArtifactCard.tsx";
import {
  ApiError,
  createFolder,
  type Folder,
  fetchFolderTree,
  fetchTags,
  setArtifactOrganization,
  setFolderParent,
  type Tag,
} from "./api.ts";
import { type FolderRow, folderAncestors, visibleFolderRows } from "./folders.ts";
import { ChevronLeftIcon, ChevronRightIcon, FolderIcon } from "./Icons.tsx";
import { useLiveEvents } from "./live.ts";
import { ROOT_FOLDER_ID } from "./router.ts";

export type LibraryProps = {
  /** Names the root of the folder tree. */
  appName: string;
  /** A folder id, `ROOT_FOLDER_ID`, or `null` for all artifacts. */
  folderId: string | null;
  tagIds: string[];
  onFilter: (filters: { folderId?: string | null; tagIds?: string[] }) => void;
};

/** Tags shown before "More…". Selected tags are always shown. */
const VISIBLE_TAGS = 8;

const OPEN_KEY = "portego.library-open";
const EXPANDED_KEY = "portego.library-expanded";

/** How long a dragged artifact rests on a collapsed folder before the folder opens. */
const SPRING_OPEN_MS = 700;

/** The share of a row's height, at its top and bottom, that marks the gap next to it. */
const GAP_EDGE = 0.25;

/** Rows are indented by this much per level. */
const INDENT_REM = 1.1;

function readOpen(): boolean {
  try {
    return window.localStorage.getItem(OPEN_KEY) !== "false";
  } catch {
    return true;
  }
}

function writeOpen(open: boolean) {
  try {
    window.localStorage.setItem(OPEN_KEY, String(open));
  } catch {
    // Storage can be blocked. The panel still works for this visit.
  }
}

function readExpanded(): Set<string> {
  try {
    const ids: unknown = JSON.parse(window.localStorage.getItem(EXPANDED_KEY) ?? "[]");
    return new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function writeExpanded(ids: Set<string>) {
  try {
    window.localStorage.setItem(EXPANDED_KEY, JSON.stringify([...ids]));
  } catch {
    // Storage can be blocked. The tree still works for this visit.
  }
}

export const FOLDER_DRAG_TYPE = "application/x-portego-folder";

/**
 * Where a dragged artifact or folder would land, with `null` for the root. `line` marks
 * the gap between two rows: dropping there files the artifact in the folder
 * that holds those rows.
 */
type DropTarget = {
  folderId: string | null;
  line?: { rowId: string; edge: "before" | "after"; depth: number };
};

function carriesItem(event: DragEvent) {
  const { types } = event.dataTransfer;
  return types.includes(ARTIFACT_DRAG_TYPE) || types.includes(FOLDER_DRAG_TYPE);
}

/** Creates a folder inside `parent`, or at the top level when there is none. */
function NewFolder({
  parent,
  onCreated,
}: {
  parent: Folder | null;
  onCreated: (folder: Folder) => void;
}) {
  const inputId = useId();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const started = useRef(false);

  useEffect(() => {
    if (editing) input.current?.focus();
    else if (started.current) opener.current?.focus();
  }, [editing]);

  function start() {
    started.current = true;
    setName("");
    setProblem(null);
    setEditing(true);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (name.trim() === "") return;
    setBusy(true);
    setProblem(null);
    try {
      onCreated(await createFolder(name.trim(), parent?.id));
      setEditing(false);
    } catch (error) {
      setProblem(error instanceof ApiError ? error.message : "Could not create the folder.");
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <button ref={opener} type="button" className="library-new" onClick={start}>
        New folder
      </button>
    );
  }

  return (
    <form className="library-new-form" onSubmit={(event) => void submit(event)}>
      <label htmlFor={inputId}>
        {parent ? `New folder in ${parent.name}` : "New top-level folder"}
      </label>
      <input
        ref={input}
        id={inputId}
        value={name}
        placeholder="Folder name"
        autoComplete="off"
        disabled={busy}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setEditing(false);
        }}
      />
      {problem ? <p role="alert">{problem}</p> : null}
      <div className="library-new-actions">
        <button type="submit" className="primary" disabled={busy || name.trim() === ""}>
          Create
        </button>
        <button type="button" disabled={busy} onClick={() => setEditing(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

type Load =
  | { status: "loading" }
  | { status: "ready"; folders: Folder[]; rootArtifactCount: number; tags: Tag[] }
  | { status: "error"; message: string };

export function Library({ appName, folderId, tagIds, onFilter }: LibraryProps) {
  const panelId = useId();
  const [open, setOpen] = useState(readOpen);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [allTags, setAllTags] = useState(false);
  const [expanded, setExpanded] = useState(readExpanded);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  // The list's own dragover handler runs in the same event as a row's, before
  // the state above re-renders, so it reads the target from here.
  const dropRef = useRef<DropTarget | null>(null);
  const [draggedFolderId, setDraggedFolderId] = useState<string | null>(null);
  const [moveProblem, setMoveProblem] = useState<string | null>(null);
  const spring = useRef<{ folderId: string; timer: number } | null>(null);
  const hideButton = useRef<HTMLButtonElement>(null);
  const showButton = useRef<HTMLButtonElement>(null);
  const toggled = useRef(false);

  const refresh = useCallback(async (quiet = false) => {
    try {
      const [tree, tags] = await Promise.all([fetchFolderTree(), fetchTags()]);
      setLoad({ status: "ready", ...tree, tags });
    } catch (error) {
      // A failed background refresh keeps the tree that is already shown.
      if (quiet) return;
      setLoad({
        status: "error",
        message: error instanceof ApiError ? error.message : "Could not load folders and tags.",
      });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useLiveEvents((event) => {
    // Comments and entries change no name or count shown here.
    if (event.type === "comment.changed" || event.type === "entry.changed") return;
    void refresh(true);
  });

  const expand = useCallback((ids: string[], open: boolean) => {
    setExpanded((current) => {
      if (ids.every((id) => current.has(id) === open)) return current;
      const next = new Set(current);
      for (const id of ids) {
        if (open) next.add(id);
        else next.delete(id);
      }
      writeExpanded(next);
      return next;
    });
  }, []);

  const folders = load.status === "ready" ? load.folders : null;

  // A newly selected folder is shown, even when it was picked elsewhere. A
  // background refresh does not reopen a parent the reader has collapsed.
  const revealed = useRef<string | null>(null);
  useEffect(() => {
    if (!folderId || !folders || revealed.current === folderId) return;
    revealed.current = folderId;
    expand(folderAncestors(folderId, folders), true);
  }, [folderId, folders, expand]);

  const stopSpring = useCallback(() => {
    if (spring.current) window.clearTimeout(spring.current.timer);
    spring.current = null;
  }, []);

  useEffect(() => stopSpring, [stopSpring]);

  // The button that was clicked is hidden, so focus moves to the one that replaced it.
  useEffect(() => {
    if (!toggled.current) return;
    (open ? hideButton : showButton).current?.focus();
  }, [open]);

  function toggle() {
    toggled.current = true;
    setOpen(!open);
    writeOpen(!open);
  }

  function toggleTag(id: string) {
    onFilter({
      tagIds: tagIds.includes(id) ? tagIds.filter((other) => other !== id) : [...tagIds, id],
    });
  }

  /** A dragged folder cannot go into itself or into one of its descendants. */
  function accepts(targetId: string | null): boolean {
    if (!draggedFolderId || targetId === null) return true;
    return (
      targetId !== draggedFolderId &&
      !folderAncestors(targetId, folders ?? []).includes(draggedFolderId)
    );
  }

  /** Shows where the item would land, and opens a collapsed folder held under it. */
  function aim(target: DropTarget, springFolderId?: string) {
    if (!accepts(target.folderId)) {
      endDrag();
      return;
    }
    dropRef.current = target;
    setDrop((current) => (JSON.stringify(current) === JSON.stringify(target) ? current : target));
    if (spring.current?.folderId === springFolderId) return;
    stopSpring();
    if (!springFolderId) return;
    spring.current = {
      folderId: springFolderId,
      timer: window.setTimeout(() => {
        spring.current = null;
        expand([springFolderId], true);
      }, SPRING_OPEN_MS),
    };
  }

  function aimAtRow(event: DragEvent<HTMLLIElement>, { folder, depth, hasChildren }: FolderRow) {
    if (!carriesItem(event)) return;
    const box = event.currentTarget.getBoundingClientRect();
    const y = box.height > 0 ? (event.clientY - box.top) / box.height : 0.5;
    const open = hasChildren && expanded.has(folder.id);
    if (y < GAP_EDGE) {
      aim({ folderId: folder.parentId, line: { rowId: folder.id, edge: "before", depth } });
    } else if (y > 1 - GAP_EDGE) {
      // Below an open folder, the gap is the top of its children.
      aim(
        open
          ? { folderId: folder.id, line: { rowId: folder.id, edge: "after", depth: depth + 1 } }
          : { folderId: folder.parentId, line: { rowId: folder.id, edge: "after", depth } },
      );
    } else {
      aim({ folderId: folder.id }, hasChildren && !open ? folder.id : undefined);
    }
  }

  function endDrag() {
    stopSpring();
    dropRef.current = null;
    setDrop(null);
  }

  async function moveArtifacts(artifactIds: string[], folderId: string | null) {
    setMoveProblem(null);
    const results = await Promise.allSettled(
      artifactIds.map((id) => setArtifactOrganization(id, { folderId })),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure) {
      setMoveProblem(
        failure.reason instanceof ApiError
          ? failure.reason.message
          : artifactIds.length === 1
            ? "Could not move the artifact."
            : "Could not move every artifact.",
      );
    }
    if (results.some((result) => result.status === "fulfilled")) await refresh(true);
  }

  async function moveFolder(id: string, parentId: string | null) {
    if (folders?.find((folder) => folder.id === id)?.parentId === parentId) return;
    setMoveProblem(null);
    try {
      await setFolderParent(id, parentId);
      if (parentId) expand([parentId], true);
      await refresh(true);
    } catch (error) {
      setMoveProblem(error instanceof ApiError ? error.message : "Could not move the folder.");
    }
  }

  /** The class for a folder button, by how the current drop relates to it. */
  function dropClass(id: string | null): string {
    if (!drop || drop.folderId !== id) return "library-folder";
    return drop.line ? "library-folder drop-parent" : "library-folder drop-target";
  }

  const tags = load.status === "ready" ? load.tags : [];
  const shownTags = allTags
    ? tags
    : tags.filter((tag, index) => index < VISIBLE_TAGS || tagIds.includes(tag.id));

  return (
    <nav aria-label="Folders and tags" className={open ? "library" : "library collapsed"}>
      <div className="library-panel" id={panelId} inert={!open}>
        <div className="library-panel-content">
          <div className="library-heading">
            <h2>Folders</h2>
            <button
              ref={hideButton}
              type="button"
              className="icon-button icon-only"
              aria-expanded={true}
              aria-controls={panelId}
              onClick={toggle}
            >
              <FolderIcon size={14} />
              <ChevronLeftIcon />
              <span>Hide folders</span>
            </button>
          </div>

          {load.status === "loading" ? <p className="hint">Loading...</p> : null}

          {load.status === "error" ? (
            <div className="library-problem">
              <p role="alert">{load.message}</p>
              <button type="button" onClick={() => void refresh()}>
                Try again
              </button>
            </div>
          ) : null}

          {load.status === "ready" ? (
            <>
              <button
                type="button"
                className="library-all"
                aria-pressed={folderId === null}
                onClick={() => onFilter({ folderId: null })}
              >
                All artifacts
              </button>

              <ul
                className="library-folders"
                onDragOver={(event) => {
                  // The narrow gaps between rows keep the last target instead
                  // of refusing the drop.
                  if (!carriesItem(event) || !dropRef.current) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) endDrag();
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const target = dropRef.current;
                  endDrag();
                  if (!target) return;
                  const artifactIds = event.dataTransfer.getData(ARTIFACT_DRAG_TYPE);
                  const movedFolderId = event.dataTransfer.getData(FOLDER_DRAG_TYPE);
                  if (artifactIds) void moveArtifacts(artifactIds.split(","), target.folderId);
                  else if (movedFolderId) void moveFolder(movedFolderId, target.folderId);
                }}
              >
                <li
                  onDragOver={(event) => {
                    if (carriesItem(event)) aim({ folderId: null });
                  }}
                >
                  <button
                    type="button"
                    className={dropClass(null)}
                    aria-pressed={folderId === ROOT_FOLDER_ID}
                    onClick={() => onFilter({ folderId: ROOT_FOLDER_ID })}
                  >
                    <FolderIcon size={13} />
                    <span className="library-folder-name">{appName}</span>
                    <span className="library-count">{load.rootArtifactCount}</span>
                  </button>
                </li>
                {visibleFolderRows(load.folders, expanded).map((row) => {
                  const { folder, depth, hasChildren } = row;
                  const open = expanded.has(folder.id);
                  const line = drop?.line?.rowId === folder.id ? drop.line : null;
                  return (
                    <li
                      key={folder.id}
                      className={
                        [
                          line ? `drop-${line.edge}` : "",
                          folder.id === draggedFolderId ? "dragging" : "",
                        ]
                          .filter(Boolean)
                          .join(" ") || undefined
                      }
                      style={{
                        // Top-level folders sit one level under the root.
                        paddingInlineStart: `${(depth + 1) * INDENT_REM}rem`,
                        ...(line ? { "--drop-indent": `${(line.depth + 1) * INDENT_REM}rem` } : {}),
                      }}
                      onDragOver={(event) => aimAtRow(event, row)}
                    >
                      {hasChildren ? (
                        <button
                          type="button"
                          className="library-disclosure"
                          aria-expanded={open}
                          aria-label={`Subfolders of ${folder.name}`}
                          onClick={() => expand([folder.id], !open)}
                        >
                          <ChevronRightIcon />
                        </button>
                      ) : (
                        <span className="library-disclosure" aria-hidden="true" />
                      )}
                      <button
                        type="button"
                        className={dropClass(folder.id)}
                        aria-pressed={folderId === folder.id}
                        onClick={() => onFilter({ folderId: folder.id })}
                        draggable
                        onDragStart={(event) => {
                          event.dataTransfer.setData(FOLDER_DRAG_TYPE, folder.id);
                          event.dataTransfer.effectAllowed = "move";
                          setDraggedFolderId(folder.id);
                        }}
                        onDragEnd={() => {
                          setDraggedFolderId(null);
                          endDrag();
                        }}
                      >
                        <FolderIcon size={13} />
                        <span className="library-folder-name">{folder.name}</span>
                        <span className="library-count">{folder.artifactCount}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>

              {moveProblem ? (
                <p className="problem" role="alert">
                  {moveProblem}
                </p>
              ) : null}

              <NewFolder
                parent={load.folders.find((folder) => folder.id === folderId) ?? null}
                onCreated={(folder) => {
                  if (folder.parentId) expand([folder.parentId], true);
                  void refresh(true);
                }}
              />

              {tags.length > 0 ? (
                <>
                  <h2>Tags</h2>
                  <div className="library-tags">
                    {shownTags.map((tag) => (
                      <button
                        key={tag.id}
                        type="button"
                        className={tagIds.includes(tag.id) ? "chip selected" : "chip"}
                        aria-pressed={tagIds.includes(tag.id)}
                        onClick={() => toggleTag(tag.id)}
                      >
                        {tag.name}
                      </button>
                    ))}
                    {tags.length > VISIBLE_TAGS ? (
                      <button type="button" className="chip" onClick={() => setAllTags(!allTags)}>
                        {allTags ? "Fewer" : "More…"}
                      </button>
                    ) : null}
                  </div>
                </>
              ) : null}
            </>
          ) : null}
        </div>
      </div>

      <div className="library-rail" inert={open}>
        <button
          ref={showButton}
          type="button"
          className="icon-button icon-only"
          aria-expanded={false}
          aria-controls={panelId}
          onClick={toggle}
        >
          <FolderIcon size={14} />
          <ChevronRightIcon />
          <span>Show folders</span>
        </button>
      </div>
    </nav>
  );
}
