import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { ApiError, createFolder, type Folder, fetchFolders, fetchTags, type Tag } from "./api.ts";
import { folderRows } from "./folders.ts";
import { ChevronLeftIcon, ChevronRightIcon, FolderIcon } from "./Icons.tsx";
import { useLiveEvents } from "./live.ts";

export type LibraryProps = {
  folderId: string | null;
  tagIds: string[];
  onFilter: (filters: { folderId?: string | null; tagIds?: string[] }) => void;
};

/** Tags shown before "More…". Selected tags are always shown. */
const VISIBLE_TAGS = 8;

const OPEN_KEY = "portego.library-open";

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

/** Creates a folder inside `parent`, or at the top level when there is none. */
function NewFolder({ parent, onCreated }: { parent: Folder | null; onCreated: () => void }) {
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
      await createFolder(name.trim(), parent?.id);
      onCreated();
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
  | { status: "ready"; folders: Folder[]; tags: Tag[] }
  | { status: "error"; message: string };

export function Library({ folderId, tagIds, onFilter }: LibraryProps) {
  const panelId = useId();
  const [open, setOpen] = useState(readOpen);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [allTags, setAllTags] = useState(false);
  const hideButton = useRef<HTMLButtonElement>(null);
  const showButton = useRef<HTMLButtonElement>(null);
  const toggled = useRef(false);

  const refresh = useCallback(async (quiet = false) => {
    try {
      const [folders, tags] = await Promise.all([fetchFolders(), fetchTags()]);
      setLoad({ status: "ready", folders, tags });
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
              <ul className="library-folders">
                <li>
                  <button
                    type="button"
                    className="library-folder"
                    aria-pressed={folderId === null}
                    onClick={() => onFilter({ folderId: null })}
                  >
                    <span className="library-folder-name">All artifacts</span>
                  </button>
                </li>
                {folderRows(load.folders).map(({ folder, depth }) => (
                  <li key={folder.id} style={{ marginInlineStart: `${depth * 1.1}rem` }}>
                    <button
                      type="button"
                      className="library-folder"
                      aria-pressed={folderId === folder.id}
                      onClick={() => onFilter({ folderId: folder.id })}
                    >
                      <FolderIcon size={13} />
                      <span className="library-folder-name">{folder.name}</span>
                      <span className="library-count">{folder.artifactCount}</span>
                    </button>
                  </li>
                ))}
              </ul>

              <NewFolder
                parent={load.folders.find((folder) => folder.id === folderId) ?? null}
                onCreated={() => void refresh(true)}
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
