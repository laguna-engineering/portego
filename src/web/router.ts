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

/** The `folderId` filter value for artifacts filed in no folder. */
export const ROOT_FOLDER_ID = "root";

export type GalleryFilters = {
  query: string;
  /** `null` is every status. The default is `open`, so "all" is explicit in the URL. */
  status: "open" | "solved" | null;
  archived: boolean;
  sort: GallerySort;
  /** `null` is every folder. The default is the root, so "all" is explicit in the URL. */
  folderId: string | null;
  tagIds: string[];
};

export type Route =
  | ({ name: "gallery" } & GalleryFilters)
  /** One artifact filling the viewport under the masthead, optionally opened on a version or comment. */
  | { name: "artifact"; id: string; versionId: string | null; commentId: string | null }
  | { name: "profile" }
  /** Another member's profile, or the user's own as others see it. */
  | { name: "member"; id: string }
  /** The MCP authorization pages. They carry the signed OAuth query through. */
  | { name: "mcp-login"; query: string }
  | { name: "mcp-consent"; query: string }
  | { name: "unknown" };

/** Reads the current URL. Two views and a search term need no router library. */
export function readRoute(url: URL): Route {
  // `/full` is the path the view had before it became the only one. Links
  // copied then still open.
  const artifact = url.pathname.match(/^\/a\/([^/]+)(?:\/full)?\/?$/);
  if (artifact?.[1]) {
    return {
      name: "artifact",
      id: decodeURIComponent(artifact[1]),
      versionId: url.searchParams.get("version") || null,
      commentId: url.searchParams.get("comment") || null,
    };
  }
  if (url.pathname === "/profile") return { name: "profile" };
  const member = url.pathname.match(/^\/u\/([^/]+)\/?$/);
  if (member?.[1]) return { name: "member", id: decodeURIComponent(member[1]) };
  if (url.pathname === "/mcp/login") return { name: "mcp-login", query: url.search };
  if (url.pathname === "/mcp/consent") return { name: "mcp-consent", query: url.search };
  if (url.pathname === "/") {
    const status = url.searchParams.get("status");
    const sort = url.searchParams.get("sort");
    return {
      name: "gallery",
      query: url.searchParams.get("q") ?? "",
      status: status === "all" ? null : status === "solved" ? "solved" : "open",
      archived: url.searchParams.get("archived") === "true",
      sort: GALLERY_SORTS.includes(sort as GallerySort)
        ? (sort as GallerySort)
        : DEFAULT_GALLERY_SORT,
      folderId: readFolder(url.searchParams.get("folder")),
      tagIds: url.searchParams.getAll("tag").filter((id) => id !== ""),
    };
  }
  return { name: "unknown" };
}

function readFolder(value: string | null): string | null {
  if (value === "all") return null;
  return value || ROOT_FOLDER_ID;
}

export function galleryPath(filters: Partial<GalleryFilters>): string {
  const search = new URLSearchParams();
  if (filters.query?.trim()) search.set("q", filters.query.trim());
  if (filters.status === null) search.set("status", "all");
  else if (filters.status && filters.status !== "open") search.set("status", filters.status);
  if (filters.archived) search.set("archived", "true");
  if (filters.sort && filters.sort !== DEFAULT_GALLERY_SORT) search.set("sort", filters.sort);
  if (filters.folderId === null) search.set("folder", "all");
  else if (filters.folderId && filters.folderId !== ROOT_FOLDER_ID)
    search.set("folder", filters.folderId);
  for (const tagId of filters.tagIds ?? []) search.append("tag", tagId);
  return search.size === 0 ? "/" : `/?${search}`;
}

export function memberPath(id: string): string {
  return `/u/${encodeURIComponent(id)}`;
}

/** What in an artifact a link opens the panel on. */
export type ArtifactTarget = { versionId?: string; commentId?: string };

export function artifactPath(id: string, target: ArtifactTarget = {}): string {
  const search = new URLSearchParams();
  if (target.versionId) search.set("version", target.versionId);
  if (target.commentId) search.set("comment", target.commentId);
  const path = `/a/${encodeURIComponent(id)}`;
  return search.size === 0 ? path : `${path}?${search}`;
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
