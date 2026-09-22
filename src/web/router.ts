import { useCallback, useEffect, useState } from "react";

export type GallerySort =
  | "updated-desc"
  | "updated-asc"
  | "created-desc"
  | "created-asc"
  | "title-asc"
  | "title-desc";

export const GALLERY_SORTS: readonly GallerySort[] = [
  "updated-desc",
  "updated-asc",
  "created-desc",
  "created-asc",
  "title-asc",
  "title-desc",
];

export const DEFAULT_GALLERY_SORT: GallerySort = "updated-desc";

export type GalleryFilters = {
  query: string;
  status: "open" | "solved" | null;
  archived: boolean;
  sort: GallerySort;
};

export type Route =
  | ({ name: "gallery" } & GalleryFilters)
  /** One artifact filling the viewport under the masthead. */
  | { name: "artifact"; id: string }
  /** The MCP authorization pages. They carry the signed OAuth query through. */
  | { name: "mcp-login"; query: string }
  | { name: "mcp-consent"; query: string }
  | { name: "unknown" };

/** Reads the current URL. Two views and a search term need no router library. */
export function readRoute(url: URL): Route {
  // `/full` is the path the view had before it became the only one. Links
  // copied then still open.
  const artifact = url.pathname.match(/^\/a\/([^/]+)(?:\/full)?\/?$/);
  if (artifact?.[1]) return { name: "artifact", id: decodeURIComponent(artifact[1]) };
  if (url.pathname === "/mcp/login") return { name: "mcp-login", query: url.search };
  if (url.pathname === "/mcp/consent") return { name: "mcp-consent", query: url.search };
  if (url.pathname === "/") {
    const status = url.searchParams.get("status");
    const sort = url.searchParams.get("sort");
    return {
      name: "gallery",
      query: url.searchParams.get("q") ?? "",
      status: status === "open" || status === "solved" ? status : null,
      archived: url.searchParams.get("archived") === "true",
      sort: GALLERY_SORTS.includes(sort as GallerySort)
        ? (sort as GallerySort)
        : DEFAULT_GALLERY_SORT,
    };
  }
  return { name: "unknown" };
}

export function galleryPath(filters: Partial<GalleryFilters>): string {
  const search = new URLSearchParams();
  if (filters.query?.trim()) search.set("q", filters.query.trim());
  if (filters.status) search.set("status", filters.status);
  if (filters.archived) search.set("archived", "true");
  if (filters.sort && filters.sort !== DEFAULT_GALLERY_SORT) search.set("sort", filters.sort);
  return search.size === 0 ? "/" : `/?${search}`;
}

export function artifactPath(id: string): string {
  return `/a/${encodeURIComponent(id)}`;
}

/**
 * The current route, plus navigation that keeps the browser's history working.
 * `replace` is for the search field, which would otherwise add a history entry
 * for every keystroke.
 */
export function useRoute(): {
  route: Route;
  navigate: (path: string, options?: { replace?: boolean }) => void;
} {
  const [route, setRoute] = useState<Route>(() => readRoute(new URL(window.location.href)));

  useEffect(() => {
    const onPopState = () => setRoute(readRoute(new URL(window.location.href)));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((path: string, options?: { replace?: boolean }) => {
    if (options?.replace) window.history.replaceState(null, "", path);
    else window.history.pushState(null, "", path);
    setRoute(readRoute(new URL(window.location.href)));
  }, []);

  return { route, navigate };
}
