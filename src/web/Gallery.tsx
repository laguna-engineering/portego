import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ArtifactCard } from "./ArtifactCard.tsx";
import { ApiError, type Artifact, fetchArtifacts, setArtifactStatus } from "./api.ts";
import { CheckIcon, CloseIcon, FolderIcon, ReopenIcon, TagIcon } from "./Icons.tsx";
import { useLiveEvents } from "./live.ts";
import { FolderPicker, TagPicker } from "./Organize.tsx";
import { GALLERY_SORTS, type GalleryFilters, type GallerySort, ROOT_FOLDER_ID } from "./router.ts";
import { FolderWatch } from "./Watch.tsx";

export type GalleryProps = {
  filters: GalleryFilters;
  /** Search is replaced in history; a filter click is a step worth going back to. */
  onFilter: (filters: Partial<GalleryFilters>, options?: { replace?: boolean }) => void;
  onOpen: (id: string) => void;
  onUpload: () => void;
};

const SORT_LABELS: Record<GallerySort, string> = {
  "updated-desc": "Last updated, newest first",
  "updated-asc": "Last updated, oldest first",
  "created-desc": "Created, newest first",
  "created-asc": "Created, oldest first",
  "title-asc": "Title, A to Z",
  "title-desc": "Title, Z to A",
};

type Load = { status: "loading" } | { status: "ready" } | { status: "error"; message: string };

export function Gallery({ filters, onFilter, onOpen, onUpload }: GalleryProps) {
  const { query, status, archived, sort, folderId } = filters;
  // The route builds a new array on every navigation. Ids have no commas, so
  // the joined string is a stable dependency.
  const tagKey = filters.tagIds.join(",");
  const atRoot = folderId === ROOT_FOLDER_ID && tagKey === "";
  const filtered = folderId !== null || tagKey !== "";
  const sortId = useId();
  const [items, setItems] = useState<Artifact[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreProblem, setMoreProblem] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [stale, setStale] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [organizing, setOrganizing] = useState<"folder" | "tags" | null>(null);
  const [changingStatus, setChangingStatus] = useState(false);
  const [statusProblem, setStatusProblem] = useState<string | null>(null);
  const moved = useRef(false);
  const request = useRef(0);

  const loadFirstPage = useCallback(
    async (quiet = false) => {
      const attempt = ++request.current;
      if (!quiet) {
        setLoad({ status: "loading" });
        // A selection belongs to the view it was made in.
        setSelectedIds([]);
      }
      try {
        const page = await fetchArtifacts({
          query,
          status,
          archived,
          sort,
          folderId,
          tagIds: tagKey === "" ? [] : tagKey.split(","),
        });
        // A slower earlier request must not overwrite a later one.
        if (attempt !== request.current) return;
        setItems(page.items);
        setSelectedIds((current) =>
          current.filter((id) => page.items.some((item) => item.id === id)),
        );
        setCursor(page.nextCursor);
        setExpanded(false);
        setStale(false);
        setLoad({ status: "ready" });
      } catch (error) {
        if (attempt !== request.current) return;
        // A reload nobody asked for keeps what is on the page. Replacing a
        // working gallery with an error message because a background refresh
        // failed would take away more than it reports.
        if (quiet) return;
        setLoad({
          status: "error",
          message: error instanceof ApiError ? error.message : "Could not load artifacts.",
        });
      }
    },
    [query, status, archived, sort, folderId, tagKey],
  );

  useLiveEvents((event) => {
    // A comment or an entry changes nothing a card shows.
    if (event.type === "comment.changed" || event.type === "entry.changed") return;
    // A gallery showing more than its first page is a place the reader walked
    // to. Rebuilding it underneath them would lose that, so it asks first.
    if (expanded) {
      setStale(true);
      return;
    }
    void loadFirstPage(true);
  });

  useEffect(() => {
    // A search runs while the term is still being typed, so the request waits
    // for a pause. Showing the whole gallery does not have to wait.
    const delay = query.trim() === "" ? 0 : 250;
    const timer = window.setTimeout(() => void loadFirstPage(), delay);
    return () => window.clearTimeout(timer);
  }, [loadFirstPage, query]);

  const selected = selectedIds.flatMap((id) => items.find((item) => item.id === id) ?? []);
  const selecting = selected.length > 0;
  const allSelected = selected.length === items.length;
  const allSolved = selected.every((artifact) => artifact.status === "solved");

  useEffect(() => {
    if (selecting) return;
    setOrganizing(null);
    setStatusProblem(null);
  }, [selecting]);

  useEffect(() => {
    if (!selecting || organizing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedIds([]);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [selecting, organizing]);

  function toggleSelected(id: string) {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((other) => other !== id) : [...current, id],
    );
  }

  function replaceItem(changed: Artifact) {
    setItems((current) => current.map((item) => (item.id === changed.id ? changed : item)));
  }

  async function toggleSolved() {
    const next = allSolved ? "open" : "solved";
    setChangingStatus(true);
    setStatusProblem(null);
    try {
      await Promise.all(
        selected
          .filter((artifact) => artifact.status !== next)
          .map(async (artifact) => replaceItem(await setArtifactStatus(artifact.id, next))),
      );
    } catch (error) {
      setStatusProblem(
        error instanceof ApiError ? error.message : "That change did not go through.",
      );
    } finally {
      setChangingStatus(false);
    }
  }

  function closeOrganizing() {
    setOrganizing(null);
    if (moved.current) setSelectedIds([]);
    moved.current = false;
  }

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    setMoreProblem(null);
    try {
      const page = await fetchArtifacts({
        query,
        status,
        archived,
        sort,
        folderId,
        tagIds: filters.tagIds,
        cursor,
      });
      setItems((current) => [...current, ...page.items]);
      setCursor(page.nextCursor);
      setExpanded(true);
    } catch (error) {
      // The artifacts already on the page stay. Only the next page failed.
      setMoreProblem(error instanceof ApiError ? error.message : "Could not load more artifacts.");
    } finally {
      setLoadingMore(false);
    }
  }

  const watchedFolderId = folderId !== null && folderId !== ROOT_FOLDER_ID ? folderId : null;

  return (
    <section className={selecting ? "gallery selecting" : "gallery"}>
      {watchedFolderId ? (
        <div className="gallery-controls">
          <FolderWatch folderId={watchedFolderId} />
        </div>
      ) : null}

      <div className="filters">
        <fieldset className="chips">
          <legend>Filter by status</legend>
          {([null, "open", "solved"] as const).map((value) => (
            <button
              key={value ?? "all"}
              type="button"
              className={status === value ? "chip selected" : "chip"}
              aria-pressed={status === value}
              onClick={() => onFilter({ status: value })}
            >
              {value === null ? "All" : value === "open" ? "Open" : "Solved"}
            </button>
          ))}
        </fieldset>

        <div className="sort">
          <label htmlFor={sortId}>Sort by</label>
          <select
            id={sortId}
            value={sort}
            onChange={(event) => onFilter({ sort: event.target.value as GallerySort })}
          >
            {GALLERY_SORTS.map((value) => (
              <option key={value} value={value}>
                {SORT_LABELS[value]}
              </option>
            ))}
          </select>
        </div>

        <label className="toggle">
          <input
            type="checkbox"
            checked={archived}
            onChange={(event) => onFilter({ archived: event.target.checked })}
          />
          Show archived
        </label>

        <button type="button" className="primary filters-upload" onClick={onUpload}>
          Upload
        </button>
      </div>

      {stale ? (
        <div className="stale">
          <p>Someone has made a change.</p>
          <button type="button" onClick={() => void loadFirstPage(true)}>
            Refresh
          </button>
        </div>
      ) : null}

      {/* With cards on screen, a line above them would push them down while the
          next page loads. The cards dim instead. */}
      {load.status === "loading" && items.length === 0 ? (
        <p className="hint">Loading artifacts...</p>
      ) : null}

      {load.status === "error" ? (
        <div className="empty">
          <p role="alert">{load.message}</p>
          <button type="button" onClick={() => void loadFirstPage()}>
            Try again
          </button>
        </div>
      ) : null}

      {load.status === "ready" && items.length === 0 ? (
        <div className="empty">
          {query.trim() !== "" ? (
            <>
              <p>Nothing matches “{query}”.</p>
              <button type="button" onClick={() => onFilter({ query: "" })}>
                Clear the search
              </button>
            </>
          ) : atRoot ? (
            <>
              <p>No artifacts outside folders.</p>
              <button type="button" onClick={() => onFilter({ folderId: null })}>
                Show all artifacts
              </button>
              <button type="button" className="primary" onClick={onUpload}>
                Upload
              </button>
            </>
          ) : filtered ? (
            <>
              <p>No artifacts match the selected folder and tags.</p>
              <button type="button" onClick={() => onFilter({ folderId: null, tagIds: [] })}>
                Show all artifacts
              </button>
            </>
          ) : (
            <>
              <p>No artifacts yet.</p>
              <button type="button" className="primary" onClick={onUpload}>
                Upload the first one
              </button>
            </>
          )}
        </div>
      ) : null}

      {items.length > 0 ? (
        <ul className="cards" aria-busy={load.status === "loading"}>
          {items.map((artifact) => (
            <ArtifactCard
              key={artifact.id}
              artifact={artifact}
              onOpen={onOpen}
              selection={selectedIds}
              onToggleSelected={toggleSelected}
              onSelectionMoved={() => setSelectedIds([])}
            />
          ))}
        </ul>
      ) : null}

      {selecting ? (
        <div className="selection-bar" role="toolbar" aria-label="Selected artifacts">
          <button
            type="button"
            className="icon-button icon-only"
            onClick={() => setSelectedIds([])}
          >
            <CloseIcon />
            <span>Clear selection</span>
          </button>
          <p className="selection-count" aria-live="polite">
            {selected.length} selected
          </p>
          <button
            type="button"
            onClick={() => setSelectedIds(allSelected ? [] : items.map((item) => item.id))}
          >
            {allSelected ? "Select none" : "Select all"}
          </button>
          <button
            type="button"
            className="icon-button"
            aria-pressed={organizing === "folder"}
            onClick={() => setOrganizing(organizing === "folder" ? null : "folder")}
          >
            <FolderIcon />
            <span>Move to folder</span>
          </button>
          <button
            type="button"
            className="icon-button"
            aria-pressed={organizing === "tags"}
            onClick={() => setOrganizing(organizing === "tags" ? null : "tags")}
          >
            <TagIcon />
            <span>Tags</span>
          </button>
          <button
            type="button"
            className="icon-button"
            disabled={changingStatus}
            onClick={() => void toggleSolved()}
          >
            {allSolved ? <ReopenIcon /> : <CheckIcon />}
            <span>{allSolved ? "Reopen" : "Mark solved"}</span>
          </button>
          {organizing === "folder" ? (
            <FolderPicker
              artifacts={selected}
              onChanged={(changed) => {
                moved.current = true;
                replaceItem(changed);
              }}
              onClose={closeOrganizing}
            />
          ) : null}
          {organizing === "tags" ? (
            <TagPicker artifacts={selected} onChanged={replaceItem} onClose={closeOrganizing} />
          ) : null}
          {statusProblem ? (
            <p className="problem" role="alert">
              {statusProblem}
            </p>
          ) : null}
        </div>
      ) : null}

      {moreProblem ? (
        <p className="problem" role="alert">
          {moreProblem}
        </p>
      ) : null}

      {cursor ? (
        <button
          type="button"
          className="more"
          disabled={loadingMore}
          onClick={() => void loadMore()}
        >
          {loadingMore ? "Loading..." : "Load more"}
        </button>
      ) : null}
    </section>
  );
}
