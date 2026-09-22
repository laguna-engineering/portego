import { DEFAULT_GALLERY_SORT, type GallerySort } from "./router.ts";

export type User = { id: string; name: string; email: string; image: string | null };

export type Provider = { id: string; label: string };

export type ArtifactStatus = "open" | "solved";

export type Artifact = {
  id: string;
  title: string;
  description: string | null;
  originalFilename: string;
  sha256: string;
  byteSize: number;
  creator: { id: string; name: string; email: string };
  createdAt: string;
  updatedAt: string;
  status: ArtifactStatus;
  archivedAt: string | null;
  versionCount: number;
  currentVersionId: string;
  /** Null when the artifact is unfiled. */
  folder: { id: string; name: string; parentId: string | null } | null;
  tags: { id: string; name: string }[];
};

/** One upload of an artifact's bytes. `sha256`, `byteSize` and
 * `originalFilename` on the artifact itself describe its current version. */
export type ArtifactVersion = {
  id: string;
  number: number;
  originalFilename: string;
  sha256: string;
  byteSize: number;
  creator: { id: string; name: string; email: string };
  createdAt: string;
};

/** A passage of the artifact's text: the quote and a little of what surrounds it. */
export type CommentAnchor = { quote: string; prefix: string; suffix: string };

export type Comment = {
  id: string;
  body: string;
  createdAt: string;
  author: { id: string; name: string; email: string };
  /** Null for a comment on the artifact as a whole. */
  anchor: CommentAnchor | null;
  /** The root comment this replies to, or null for a root comment itself. */
  parentId: string | null;
  /** The version this comment was written on. */
  versionId: string;
  versionNumber: number;
};

/** `artifactCount` counts artifacts filed or tagged directly, including solved and archived ones. */
export type Folder = { id: string; name: string; parentId: string | null; artifactCount: number };

export type Tag = { id: string; name: string; artifactCount: number };

export type GalleryFilters = {
  query?: string;
  status?: ArtifactStatus | null;
  archived?: boolean;
  sort?: GallerySort;
  /** Matches artifacts filed directly in this folder, not in its children. */
  folderId?: string | null;
  /** Matches artifacts that carry every one of these tags. */
  tagIds?: string[];
};

export type Page = { items: Artifact[]; nextCursor: string | null };

export type Preview = { url: string; expiresAt: string };

/** The shape every failing API response carries. */
export type ApiErrorBody = { error: { code: string; message: string } };

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError("OFFLINE", "Could not reach the server.", 0);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
    throw new ApiError(
      body?.error.code ?? "UNKNOWN",
      body?.error.message ?? "Something went wrong.",
      res.status,
    );
  }
  return (await res.json()) as T;
}

export type Session = { user: User; limits: { maxUploadBytes: number } };

/** The session, or null when nobody is signed in. */
export async function fetchSession(): Promise<Session | null> {
  try {
    return await request<Session>("/api/me");
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

export function fetchProviders(): Promise<Provider[]> {
  return request<{ providers: Provider[] }>("/api/auth-providers").then((body) => body.providers);
}

export function fetchArtifacts(
  options: GalleryFilters & { cursor?: string | null },
): Promise<Page> {
  const search = new URLSearchParams();
  if (options.query) search.set("q", options.query);
  if (options.status) search.set("status", options.status);
  if (options.archived) search.set("archived", "true");
  if (options.sort && options.sort !== DEFAULT_GALLERY_SORT) search.set("sort", options.sort);
  if (options.folderId) search.set("folderId", options.folderId);
  for (const tagId of options.tagIds ?? []) search.append("tagId", tagId);
  if (options.cursor) search.set("cursor", options.cursor);
  const suffix = search.size > 0 ? `?${search}` : "";
  return request<Page>(`/api/artifacts${suffix}`);
}

export function fetchFolders(): Promise<Folder[]> {
  return request<{ folders: Folder[] }>("/api/folders").then((body) => body.folders);
}

export function fetchTags(): Promise<Tag[]> {
  return request<{ tags: Tag[] }>("/api/tags").then((body) => body.tags);
}

export function fetchArtifact(id: string): Promise<Artifact> {
  return request<{ artifact: Artifact }>(`/api/artifacts/${encodeURIComponent(id)}`).then(
    (body) => body.artifact,
  );
}

/**
 * `artifactId` turns the upload into a new version of an existing artifact
 * instead of creating one. `newArtifact` in the response is false in that case.
 */
export function uploadArtifact(input: {
  file: File;
  title: string;
  description: string;
  artifactId?: string;
}): Promise<{ artifact: Artifact; newArtifact: boolean }> {
  const form = new FormData();
  form.set("file", input.file);
  form.set("title", input.title);
  form.set("description", input.description);
  if (input.artifactId) form.set("artifactId", input.artifactId);
  return request<{ artifact: Artifact; newArtifact: boolean }>("/api/artifacts", {
    method: "POST",
    body: form,
  });
}

/**
 * Asks for a short-lived URL on the isolated content host. The URL is a
 * capability: it works without a session and only for this one artifact.
 * `versionId` defaults to the current version on the server.
 */
export function mintPreview(artifactId: string, versionId?: string | null): Promise<Preview> {
  const suffix = versionId ? `?version=${encodeURIComponent(versionId)}` : "";
  return request<Preview>(`/api/artifacts/${encodeURIComponent(artifactId)}/preview${suffix}`, {
    method: "POST",
  });
}

/** Every version of one artifact, highest number (the current one) first. */
export function fetchVersions(id: string): Promise<ArtifactVersion[]> {
  return request<{ versions: ArtifactVersion[] }>(
    `/api/artifacts/${encodeURIComponent(id)}/versions`,
  ).then((body) => body.versions);
}

/**
 * Starts the provider's browser flow. Returns the URL to send the user to.
 * `callbackURL` is where the browser lands afterwards, which the MCP
 * authorization pages use to resume the flow they interrupted.
 */
export async function startSignIn(providerId: string, callbackURL = "/"): Promise<string> {
  const body = await request<{ url?: string }>("/api/auth/sign-in/social", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: providerId, callbackURL, errorCallbackURL: "/" }),
  });
  if (!body.url) throw new ApiError("NO_URL", "The provider returned no sign-in URL.", 500);
  return body.url;
}

export async function signOut(): Promise<void> {
  await request("/api/auth/sign-out", { method: "POST" });
}

export function setArtifactStatus(id: string, status: ArtifactStatus): Promise<Artifact> {
  return request<{ artifact: Artifact }>(`/api/artifacts/${encodeURIComponent(id)}/status`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status }),
  }).then((body) => body.artifact);
}

export function setArtifactArchived(id: string, archived: boolean): Promise<Artifact> {
  return request<{ artifact: Artifact }>(`/api/artifacts/${encodeURIComponent(id)}/archived`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ archived }),
  }).then((body) => body.artifact);
}

/** Without `parentId` the folder is created at the top level. */
export function createFolder(name: string, parentId?: string): Promise<Folder> {
  return request<{ folder: Folder }>("/api/folders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(parentId ? { name, parentId } : { name }),
  }).then((body) => body.folder);
}

export function createTag(name: string): Promise<Tag> {
  return request<{ tag: Tag }>("/api/tags", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  }).then((body) => body.tag);
}

/** `folderId: null` unfiles the artifact. `tagIds` replaces the whole set. */
export function setArtifactOrganization(
  id: string,
  organization: { folderId?: string | null; tagIds?: string[] },
): Promise<Artifact> {
  return request<{ artifact: Artifact }>(`/api/artifacts/${encodeURIComponent(id)}/organization`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(organization),
  }).then((body) => body.artifact);
}

export function fetchComments(id: string): Promise<Comment[]> {
  return request<{ comments: Comment[] }>(`/api/artifacts/${encodeURIComponent(id)}/comments`).then(
    (body) => body.comments,
  );
}

/**
 * A reply carries `parentId` and never `anchor`; a root comment may carry
 * `anchor`. `versionId` defaults to the artifact's current version and is
 * ignored by the server for a reply, which always takes its parent's version.
 */
export function addComment(
  id: string,
  body: string,
  options: {
    anchor?: CommentAnchor | null;
    parentId?: string | null;
    versionId?: string | null;
  } = {},
): Promise<Comment> {
  const { anchor = null, parentId = null, versionId = null } = options;
  const payload: { body: string; anchor?: CommentAnchor; parentId?: string; versionId?: string } = {
    body,
  };
  if (anchor) payload.anchor = anchor;
  if (parentId) payload.parentId = parentId;
  if (versionId) payload.versionId = versionId;
  return request<{ comment: Comment }>(`/api/artifacts/${encodeURIComponent(id)}/comments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }).then((response) => response.comment);
}

export async function deleteComment(artifactId: string, commentId: string): Promise<void> {
  const res = await fetch(
    `/api/artifacts/${encodeURIComponent(artifactId)}/comments/${encodeURIComponent(commentId)}`,
    { method: "DELETE" },
  );
  if (!res.ok) throw new ApiError("DELETE_FAILED", "Could not remove that comment.", res.status);
}

export type Markdown = {
  markdown: string;
  empty: boolean;
  source: "provided" | "generated";
  converterVersion: string;
  generatedAt: string;
};

/**
 * The artifact's supplied Markdown or static content. HTML is parsed without
 * running scripts. `versionId` defaults to the current version on the server.
 */
export function fetchMarkdown(artifactId: string, versionId?: string | null): Promise<Markdown> {
  const suffix = versionId ? `?version=${encodeURIComponent(versionId)}` : "";
  return request<Markdown>(`/api/artifacts/${encodeURIComponent(artifactId)}/markdown${suffix}`);
}

export type OAuthClient = { clientId: string; clientName?: string; clientUri?: string };

/** The client asking for access, so the consent page can name it. */
export async function fetchOAuthClient(clientId: string): Promise<OAuthClient> {
  return await request<OAuthClient>(
    `/api/auth/oauth2/get-client?client_id=${encodeURIComponent(clientId)}`,
  );
}

/** Approves or denies an MCP authorization request. Returns where to go next. */
export async function decideConsent(input: {
  accept: boolean;
  oauthQuery: string;
}): Promise<string> {
  const body = await request<{ url?: string; redirect_uri?: string }>("/api/auth/oauth2/consent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accept: input.accept, oauth_query: input.oauthQuery }),
  });
  const redirect = body.url ?? body.redirect_uri;
  if (!redirect)
    throw new ApiError("NO_REDIRECT", "The authorization server returned no redirect.", 500);
  return redirect;
}

/** `versionId` defaults to the current version on the server. */
export function sourceUrl(artifactId: string, versionId?: string | null): string {
  const suffix = versionId ? `?version=${encodeURIComponent(versionId)}` : "";
  return `/api/artifacts/${encodeURIComponent(artifactId)}/source${suffix}`;
}
