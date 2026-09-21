import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ArtifactCard } from "./ArtifactCard.tsx";
import { ApiError, type Artifact, fetchArtifacts } from "./api.ts";
import { useLiveEvents } from "./live.ts";
import { GALLERY_SORTS, type GalleryFilters, type GallerySort } from "./router.ts";

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
  const { query, status, archived, sort } = filters;
  const searchId = useId();
  const sortId = useId();
  const [items, setItems] = useState<Artifact[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreProblem, setMoreProblem] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [stale, setStale] = useState(false);
  const request = useRef(0);

  const loadFirstPage = useCallback(
    async (quiet = false) => {
      const attempt = ++request.current;
      if (!quiet) setLoad({ status: "loading" });
      try {
        const page = await fetchArtifacts({ query, status, archived, sort });
        // A slower earlier request must not overwrite a later one.
        if (attempt !== request.current) return;
        setItems(page.items);
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
    [query, status, archived, sort],
  );

  useLiveEvents((event) => {
    // A comment changes nothing a card shows.
    if (event.type === "comment.changed") return;
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

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    setMoreProblem(null);
    try {
      const page = await fetchArtifacts({ query, status, archived, sort, cursor });
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

  return (
    <section className="gallery">
      <div className="gallery-controls">
        <div className="search">
          <label htmlFor={searchId}>Search artifacts</label>
          <input
            id={searchId}
            type="search"
            value={query}
            placeholder="Title or description"
            onChange={(event) => onFilter({ query: event.target.value }, { replace: true })}
          />
        </div>
        <button type="button" className="primary" onClick={onUpload}>
          Upload
        </button>
      </div>

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
      </div>

      {stale ? (
        <div className="stale">
          <p>Someone has made a change.</p>
          <button type="button" onClick={() => void loadFirstPage(true)}>
            Refresh
          </button>
        </div>
      ) : null}

      {load.status === "loading" ? <p className="hint">Loading artifacts...</p> : null}

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
          {query.trim() === "" ? (
            <>
              <p>No artifacts yet.</p>
              <button type="button" className="primary" onClick={onUpload}>
                Upload the first one
              </button>
            </>
          ) : (
            <>
              <p>Nothing matches “{query}”.</p>
              <button type="button" onClick={() => onFilter({ query: "" })}>
                Clear the search
              </button>
            </>
          )}
        </div>
      ) : null}

      {items.length > 0 ? (
        <ul className="cards">
          {items.map((artifact) => (
            <ArtifactCard key={artifact.id} artifact={artifact} onOpen={onOpen} />
          ))}
        </ul>
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
