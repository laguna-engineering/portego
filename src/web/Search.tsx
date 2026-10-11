import {
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { mark } from "./ArtifactCard.tsx";
import {
  ApiError,
  type Artifact,
  fetchFolders,
  type SearchResults,
  searchArtifacts,
  type TextSegment,
} from "./api.ts";
import { folderPath } from "./folders.ts";
import { CommentIcon, FolderIcon, SearchIcon } from "./Icons.tsx";
import { RelativeTime } from "./RelativeTime.tsx";
import type { ArtifactTarget, GalleryFilters } from "./router.ts";

/** Where a search looks. One artifact is searched like a browser's find, in the artifact itself. */
type Scope = { kind: "everywhere" } | { kind: "folder"; folderId: string } | { kind: "artifact" };

/**
 * How many matches a find has, and which one is current, counted from 0.
 * `more` is true when there are more matches than `count`.
 */
export type FindResult = { count: number; index: number; more: boolean };

/** Finds in the artifact on screen. `run` marks the matches of `query` and makes `index` current. */
export type Find = { result: FindResult | null; run: (query: string, index: number) => void };

export type SearchProps = {
  /** The text the field starts with, e.g. the gallery's current search. */
  initialQuery?: string;
  /** Starts finding in the artifact on screen, e.g. for a link to a match in it. */
  initialScope?: "everywhere" | "artifact";
  /** Offers a scope for this folder. */
  folderId?: string | null;
  /** Offers a scope that finds in the artifact on screen. */
  find?: Find | null;
  /** Includes archived artifacts, as the gallery does when it shows them. */
  archived?: boolean;
  onOpenArtifact: (id: string, target?: ArtifactTarget) => void;
  /** Shows the gallery with these filters, e.g. a search or a tag. */
  onOpenGallery: (filters: Partial<GalleryFilters>) => void;
};

type Item = { key: string; select: () => void; render: () => ReactNode };

const SEARCH_DELAY_MS = 200;
/** Shorter: a find runs in the page, with no request. */
const FIND_DELAY_MS = 100;

function Marked({ segments }: { segments: TextSegment[] }) {
  return (
    <>
      {segments.map((segment, index) =>
        segment.match ? (
          // Segments never change order, so the index is a stable key.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above
          <strong key={index} className="search-match">
            {segment.text}
          </strong>
        ) : (
          segment.text
        ),
      )}
    </>
  );
}

function ArtifactMark({ artifact }: { artifact: Artifact }) {
  return (
    <span className="search-mark" aria-hidden="true" style={{ background: mark(artifact.id) }}>
      {artifact.title.slice(0, 2).toUpperCase()}
    </span>
  );
}

/** "/" anywhere outside a text field, as in the gallery and the artifact view. */
export function useSearchShortcut(onShortcut: () => void) {
  const callback = useRef(onShortcut);
  useEffect(() => {
    callback.current = onShortcut;
  });
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      ) {
        return;
      }
      event.preventDefault();
      callback.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
}

/**
 * The field, its scopes, and the grouped results under it, with keyboard
 * selection. `onEmptyEnter` handles Enter in an empty field.
 */
function useSearch(props: SearchProps & { onDone: () => void; onEmptyEnter?: () => void }) {
  const { folderId = null, find = null, archived = false } = props;
  const [query, setQuery] = useState(props.initialQuery ?? "");
  const [scope, setScope] = useState<Scope>(
    props.initialScope === "artifact" ? { kind: "artifact" } : { kind: "everywhere" },
  );
  const [results, setResults] = useState<SearchResults | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [active, setActive] = useState(-1);
  const [folderLabel, setFolderLabel] = useState<string | null>(null);
  const request = useRef(0);
  const listId = useId();

  useEffect(() => {
    if (!folderId) return;
    let current = true;
    fetchFolders()
      .then((folders) => {
        const folder = folders.find((other) => other.id === folderId);
        if (current && folder) setFolderLabel(folderPath(folder, folders));
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [folderId]);

  // A scope that no longer exists falls back to everything.
  const scopeFolderId = scope.kind === "folder" && scope.folderId === folderId ? folderId : null;
  const finding = scope.kind === "artifact" && find !== null;
  const runFind = useRef(find?.run);
  useEffect(() => {
    runFind.current = find?.run;
  });

  // Leaving the scope, or closing, takes the marks off the artifact.
  useEffect(() => {
    if (!finding) return;
    return () => runFind.current?.("", 0);
  }, [finding]);

  useEffect(() => {
    if (!finding) return;
    const timer = window.setTimeout(() => runFind.current?.(query, 0), FIND_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [finding, query]);

  useEffect(() => {
    const attempt = ++request.current;
    setActive(-1);
    if (finding || query.trim() === "") {
      setResults(null);
      setProblem(null);
      return;
    }
    const timer = window.setTimeout(() => {
      searchArtifacts({
        query,
        folderId: scopeFolderId,
        archived,
      })
        .then((found) => {
          if (attempt !== request.current) return;
          setResults(found);
          setProblem(null);
        })
        .catch((error) => {
          if (attempt !== request.current) return;
          setProblem(error instanceof ApiError ? error.message : "Search did not go through.");
        });
    }, SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [query, scopeFolderId, finding, archived]);

  const done = (action: () => void) => () => {
    action();
    props.onDone();
  };
  // Every status and no tag, so the gallery lists what `total` counts.
  const showAll = done(() =>
    props.onOpenGallery({ query: query.trim(), folderId: scopeFolderId, status: null, tagIds: [] }),
  );

  const groups: { label: string; items: Item[] }[] = results
    ? [
        {
          label: "Artifacts",
          items: results.artifacts.map(({ artifact, title, snippet }) => ({
            key: `artifact:${artifact.id}`,
            select: done(() => props.onOpenArtifact(artifact.id)),
            render: () => (
              <>
                <ArtifactMark artifact={artifact} />
                <span className="search-text">
                  <span className="search-title">
                    <Marked segments={title} />
                  </span>
                  {snippet ? (
                    <span className="search-snippet">
                      <Marked segments={snippet} />
                    </span>
                  ) : null}
                  <span className="search-meta">
                    {artifact.folder ? `${artifact.folder.name} · ` : ""}
                    {artifact.creator.name} · <RelativeTime iso={artifact.updatedAt} />
                  </span>
                </span>
              </>
            ),
          })),
        },
        {
          label: "Inside artifacts",
          items: results.content.map(({ artifact, snippet, matches }) => {
            // The words as the text has them, which a find in the artifact matches.
            const matched = snippet.find((segment) => segment.match)?.text.trim();
            return {
              key: `content:${artifact.id}`,
              select: done(() =>
                props.onOpenArtifact(artifact.id, matched ? { find: matched } : undefined),
              ),
              render: () => (
                <>
                  <ArtifactMark artifact={artifact} />
                  <span className="search-text">
                    <span className="search-title">
                      {artifact.title}
                      {artifact.versionCount > 1 ? (
                        <span className="badge search-badge">v{artifact.versionCount}</span>
                      ) : null}
                      {matches > 1 ? (
                        <span className="search-count"> · {matches} matches</span>
                      ) : null}
                    </span>
                    <span className="search-snippet">
                      <Marked segments={snippet} />
                    </span>
                  </span>
                </>
              ),
            };
          }),
        },
        {
          label: "Comments",
          items: results.comments.map(({ artifact, comment, snippet }) => ({
            key: `comment:${comment.id}`,
            select: done(() => props.onOpenArtifact(artifact.id, { commentId: comment.id })),
            render: () => (
              <>
                <span className="search-mark search-icon" aria-hidden="true">
                  <CommentIcon />
                </span>
                <span className="search-text">
                  <span className="search-title">
                    {comment.author.name} on {artifact.title}
                  </span>
                  <span className="search-snippet">
                    “<Marked segments={snippet} />”
                  </span>
                </span>
              </>
            ),
          })),
        },
        {
          label: "Folders",
          items: results.folders.map((folder) => ({
            key: `folder:${folder.id}`,
            select: done(() => props.onOpenGallery({ query: "", folderId: folder.id })),
            render: () => (
              <>
                <span className="search-mark search-icon" aria-hidden="true">
                  <FolderIcon />
                </span>
                <span className="search-text">
                  <span className="search-title">
                    {folder.name} <span className="search-count">{folder.count}</span>
                  </span>
                </span>
              </>
            ),
          })),
        },
      ].filter((group) => group.items.length > 0)
    : [];
  const tagItems: Item[] = (results?.tags ?? []).map((tag) => ({
    key: `tag:${tag.id}`,
    select: done(() => props.onOpenGallery({ query: "", folderId: null, tagIds: [tag.id] })),
    render: () => (
      <>
        {tag.name} <span className="search-count">{tag.count}</span>
      </>
    ),
  }));
  const items = [...groups.flatMap((group) => group.items), ...tagItems];
  const optionId = (index: number) => `${listId}-${index}`;
  // The artifacts the groups show, which `total` counts. Folders and tags are counted apart.
  const shown = results
    ? new Set(
        [...results.artifacts, ...results.content, ...results.comments].map(
          ({ artifact }) => artifact.id,
        ),
      ).size
    : 0;

  /** Moves to the next or previous match. The artifact wraps around at either end. */
  function step(by: 1 | -1) {
    const result = find?.result;
    if (!result || result.count === 0) return;
    runFind.current?.(query, result.index + by);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (finding) {
      if (event.key === "Enter" || event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        step(event.key === "ArrowUp" || (event.key === "Enter" && event.shiftKey) ? -1 : 1);
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (items.length === 0) return;
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      // -1 is the field itself, so the selection cycles through it.
      setActive((current) => ((current + 1 + step + items.length + 1) % (items.length + 1)) - 1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const item = items[active];
      if (item) item.select();
      else if (query.trim() !== "") showAll();
      else props.onEmptyEnter?.();
    }
  }

  const scopes: { scope: Scope; label: string }[] = [
    { scope: { kind: "everywhere" }, label: "Everywhere" },
    ...(folderId && folderLabel
      ? [{ scope: { kind: "folder", folderId } as Scope, label: `In ${folderLabel}` }]
      : []),
    ...(find ? [{ scope: { kind: "artifact" } as Scope, label: "This artifact" }] : []),
  ];
  const scopeSelected = (other: Scope) =>
    other.kind === "everywhere"
      ? scopeFolderId === null && !finding
      : other.kind === "folder"
        ? scopeFolderId !== null
        : finding;

  const findResult = finding ? find?.result : null;
  const findCount = findResult
    ? findResult.count === 0
      ? "No matches"
      : `${findResult.index + 1} of ${findResult.count}${findResult.more ? "+" : ""}`
    : null;

  let index = 0;
  const option = (item: Item) => {
    const position = index++;
    const isActive = position === active;
    return (
      <li key={item.key} role="presentation">
        <button
          type="button"
          id={optionId(position)}
          role="option"
          aria-selected={isActive}
          tabIndex={-1}
          className={item.key.startsWith("tag:") ? "chip search-tag" : "search-option"}
          // Keeps the focus in the field, so the arrow keys still work.
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => setActive(position)}
          onClick={item.select}
        >
          {item.render()}
        </button>
      </li>
    );
  };

  const panel =
    query.trim() === "" ? null : (
      <div className="search-panel">
        <div className="search-scopes">
          {scopes.length > 1
            ? scopes.map(({ scope: other, label }) => (
                <button
                  key={other.kind}
                  type="button"
                  className={scopeSelected(other) ? "chip selected" : "chip"}
                  aria-pressed={scopeSelected(other)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => setScope(other)}
                >
                  {label}
                </button>
              ))
            : null}
          {results ? (
            <span className="search-total">
              {results.total} {results.total === 1 ? "artifact" : "artifacts"}
            </span>
          ) : null}
          {finding ? (
            <span className="search-total search-find">
              <span role="status">{findCount}</span>
              <button
                type="button"
                className="find-step"
                aria-label="Previous match"
                disabled={!findResult?.count}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => step(-1)}
              >
                ↑
              </button>
              <button
                type="button"
                className="find-step"
                aria-label="Next match"
                disabled={!findResult?.count}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => step(1)}
              >
                ↓
              </button>
            </span>
          ) : null}
        </div>
        {finding ? (
          <div className="search-footer">
            <span>Enter for the next match · Shift+Enter for the previous · Esc to close</span>
          </div>
        ) : null}
        {problem ? <p role="alert">{problem}</p> : null}
        {results && items.length === 0 ? <p className="hint">Nothing matches “{query}”.</p> : null}
        <div id={listId} role="listbox" aria-label="Search results" className="search-groups">
          {groups.map((group) => (
            <div key={group.label} className="search-group">
              <p className="search-group-label">{group.label}</p>
              <ul>{group.items.map(option)}</ul>
            </div>
          ))}
          {tagItems.length > 0 ? (
            <div className="search-group search-tags">
              <p className="search-group-label">Tags</p>
              <ul>{tagItems.map(option)}</ul>
            </div>
          ) : null}
        </div>
        {results && items.length > 0 ? (
          <div className="search-footer">
            <span>↑ ↓ to move · Enter to open · Esc to close</span>
            {results.total > shown ? (
              <button
                type="button"
                className="link-button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={showAll}
              >
                Show all {results.total} artifacts
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    );

  const input = (inputRef: Ref<HTMLInputElement>, onFocus?: () => void) => (
    <span className="search-field">
      <SearchIcon size={15} />
      <input
        ref={inputRef}
        type="search"
        value={query}
        aria-label="Search everything"
        placeholder="Search artifacts, content, and comments"
        role="combobox"
        aria-expanded={panel !== null && !finding}
        aria-controls={listId}
        aria-activedescendant={active >= 0 ? optionId(active) : undefined}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
      />
    </span>
  );

  return { query, setQuery, panel, input };
}

/** The gallery's search, open in the masthead. Results drop down while the field has focus. */
export function SearchField(props: SearchProps) {
  const [open, setOpen] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const onDone = () => {
    setOpen(false);
    field.current?.blur();
  };
  const { setQuery, panel, input } = useSearch({
    ...props,
    onDone,
    // Clearing the field and pressing Enter clears the gallery's search.
    onEmptyEnter: props.initialQuery
      ? () => {
          props.onOpenGallery({ query: "" });
          onDone();
        }
      : undefined,
  });

  // The gallery's search can change from elsewhere, e.g. "Clear the search".
  useEffect(() => {
    setQuery(props.initialQuery ?? "");
  }, [props.initialQuery, setQuery]);

  useSearchShortcut(() => field.current?.focus());

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape and focus leaving are handled for the whole box
    <div
      ref={box}
      className="masthead-search"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setOpen(false);
          field.current?.blur();
        }
      }}
      onBlur={(event) => {
        if (!box.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      {input(field, () => setOpen(true))}
      {open && panel ? <div className="search-dropdown">{panel}</div> : null}
    </div>
  );
}

/** The artifact view's search: a popover with the field and the same results. */
export function SearchPopover(props: SearchProps & { onClose: () => void }) {
  const field = useRef<HTMLInputElement>(null);
  const close = useRef(props.onClose);
  const { panel, input } = useSearch({ ...props, onDone: props.onClose });

  useEffect(() => {
    close.current = props.onClose;
  });

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    field.current?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") close.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  return (
    <>
      <button
        type="button"
        className="popover-backdrop"
        aria-hidden="true"
        tabIndex={-1}
        onClick={props.onClose}
      />
      <div className="popover search-popover" role="dialog" aria-label="Search">
        {input(field)}
        {panel}
      </div>
    </>
  );
}
