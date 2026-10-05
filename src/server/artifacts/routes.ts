import { type Context, Hono } from "hono";
import type { AppEnv } from "../auth/middleware.ts";
import { currentUser, requireUser } from "../auth/middleware.ts";
import type { OrganizationService } from "../organization/service.ts";
import type { PreviewIssuer } from "../preview/tokens.ts";
import { LIST_SORTS, type ListSort, type TagMatch } from "../storage/artifacts.ts";
import type { ErrorCode } from "./errors.ts";
import { ServiceError } from "./errors.ts";
import type { ArtifactService, UploadResult } from "./service.ts";
import { verifyUploadTicket } from "./tickets.ts";

const STATUS: Record<ErrorCode, 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500> = {
  UNAUTHENTICATED: 401,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  PRIVATE: 403,
  INVALID_INPUT: 400,
  TITLE_REQUIRED: 400,
  TITLE_EXISTS: 409,
  FILE_TOO_LARGE: 413,
  UNSUPPORTED_CONTENT: 400,
  INVALID_CURSOR: 400,
  RATE_LIMITED: 429,
  CONTENT_MISSING: 500,
  INTERNAL: 500,
};

/** Room for the multipart headers around a file of the maximum size. */
const MULTIPART_OVERHEAD_BYTES = 16 * 1024;

/** The largest request body an upload can need: the document plus every image. */
export function maxUploadRequestBytes(limits: {
  maxUploadBytes: number;
  maxImageBytesTotal: number;
}): number {
  return limits.maxUploadBytes + limits.maxImageBytesTotal + MULTIPART_OVERHEAD_BYTES;
}

function ascii(filename: string): string {
  // A quote or a backslash would end the quoted string early.
  return filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
}

/** RFC 6266: an ASCII name every client understands, plus the exact one. */
function contentDisposition(filename: string): string {
  return `attachment; filename="${ascii(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * Turns a service refusal into the JSON error shape the web client and the MCP
 * adapter share. Hono hands a thrown error to the error handler of the app
 * that dispatched the request, so this is registered on the root app.
 */
export function handleServiceError(error: Error, c: Context<AppEnv>): Response {
  if (error instanceof ServiceError) {
    return c.json(
      {
        error: {
          code: error.code,
          message: error.message,
          ...(error.artifactId === undefined ? {} : { artifactId: error.artifactId }),
        },
      },
      STATUS[error.code],
    );
  }
  console.error(error);
  return c.json({ error: { code: "INTERNAL", message: "Something went wrong." } }, STATUS.INTERNAL);
}

export function artifactRoutes(
  service: ArtifactService,
  issuePreview: PreviewIssuer,
  organization: OrganizationService,
): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  // Every artifact route needs a session. Refusing before any lookup keeps an
  // anonymous request from learning whether an id exists.
  routes.use("*", requireUser);

  const viewer = (c: Context<AppEnv>) => ({ userId: currentUser(c).id });

  routes.get("/", (c) => {
    const limitParameter = c.req.query("limit");
    const limit = limitParameter === undefined ? undefined : Number(limitParameter);
    if (limit !== undefined && !Number.isInteger(limit)) {
      throw new ServiceError("INVALID_INPUT", "limit must be a whole number.");
    }

    const status = c.req.query("status");
    if (status !== undefined && status !== "open" && status !== "solved") {
      throw new ServiceError("INVALID_INPUT", "status must be open or solved.");
    }

    const sort = c.req.query("sort");
    if (sort !== undefined && !LIST_SORTS.includes(sort as ListSort)) {
      throw new ServiceError("INVALID_INPUT", `sort must be one of ${LIST_SORTS.join(", ")}.`);
    }

    const folderId = c.req.query("folderId") ?? null;
    const tagIds = c.req.queries("tagId") ?? [];
    const tagMatch = c.req.query("tagMatch") ?? "all";
    if (tagMatch !== "all" && tagMatch !== "any") {
      throw new ServiceError("INVALID_INPUT", "tagMatch must be all or any.");
    }
    organization.validateListFilters({ folderId, tagIds });

    const page = service.list(viewer(c), {
      query: c.req.query("q") ?? null,
      cursor: c.req.query("cursor") ?? null,
      sort: (sort as ListSort | undefined) ?? null,
      status: status ?? null,
      folderId,
      tagIds,
      tagMatch: tagMatch as TagMatch,
      // Archived artifacts stay out of the gallery unless they are asked for.
      includeArchived: c.req.query("archived") === "true",
      ...(limit === undefined ? {} : { limit }),
    });
    return c.json(page);
  });

  routes.post("/", async (c) => {
    const result = await uploadFromForm(c, service, currentUser(c).id, { inApp: true });
    return c.json(result, 201);
  });

  routes.get("/:id", (c) => c.json({ artifact: service.get(c.req.param("id"), viewer(c)) }));

  routes.get("/:id/versions", (c) =>
    c.json({ versions: service.versions(c.req.param("id"), viewer(c)) }),
  );

  // A preview URL is a capability, so it is issued to a session and not
  // readable from one. The artifact is looked up first, which refuses an id
  // the caller cannot see before any token exists for it.
  routes.post("/:id/preview", async (c) => {
    const { artifact, version } = await service.source(
      c.req.param("id"),
      viewer(c),
      c.req.query("version") ?? null,
    );
    const preview = issuePreview({
      artifactId: artifact.id,
      versionId: version.id,
      viewerId: currentUser(c).id,
    });
    return c.json({ url: preview.url, expiresAt: preview.expiresAt });
  });

  routes.patch("/:id/status", async (c) => {
    const body = await readJson(c);
    const status = body.status;
    if (status !== "open" && status !== "solved") {
      throw new ServiceError("INVALID_INPUT", "status must be open or solved.");
    }
    return c.json({
      artifact: service.setStatus(c.req.param("id"), status, currentUser(c).id, { inApp: true }),
    });
  });

  routes.patch("/:id/archived", async (c) => {
    const body = await readJson(c);
    if (typeof body.archived !== "boolean") {
      throw new ServiceError("INVALID_INPUT", "archived must be true or false.");
    }
    return c.json({
      artifact: service.setArchived(c.req.param("id"), body.archived, currentUser(c).id, {
        inApp: true,
      }),
    });
  });

  routes.patch("/:id/visibility", async (c) => {
    const body = await readJson(c);
    return c.json({
      artifact: service.setVisibility(c.req.param("id"), body.visibility, currentUser(c).id),
    });
  });

  routes.patch("/:id/organization", async (c) => {
    const body = await readJson(c);
    service.get(c.req.param("id"), viewer(c));
    organization.setArtifactOrganization(c.req.param("id"), {
      ...(Object.hasOwn(body, "folderId") ? { folderId: body.folderId } : {}),
      ...(Object.hasOwn(body, "tagIds") ? { tagIds: body.tagIds } : {}),
      actorId: currentUser(c).id,
    });
    return c.json({ artifact: service.get(c.req.param("id"), viewer(c)) });
  });

  routes.get("/:id/comments", (c) =>
    c.json({ comments: service.comments(c.req.param("id"), viewer(c)) }),
  );

  routes.post("/:id/comments", async (c) => {
    const body = await readJson(c);
    if (typeof body.body !== "string") {
      throw new ServiceError("INVALID_INPUT", "Send the comment text as `body`.");
    }
    if (body.anchor !== undefined && body.anchor !== null && typeof body.anchor !== "object") {
      throw new ServiceError(
        "INVALID_INPUT",
        "anchor must be an object with quote, prefix, and suffix.",
      );
    }
    if (
      body.parentId !== undefined &&
      body.parentId !== null &&
      typeof body.parentId !== "string"
    ) {
      throw new ServiceError("INVALID_INPUT", "parentId must be a string.");
    }
    if (
      body.versionId !== undefined &&
      body.versionId !== null &&
      typeof body.versionId !== "string"
    ) {
      throw new ServiceError("INVALID_INPUT", "versionId must be a string.");
    }
    const comment = service.addComment(c.req.param("id"), {
      authorId: currentUser(c).id,
      body: body.body,
      anchor: body.anchor ?? undefined,
      parentId: body.parentId ?? undefined,
      versionId: body.versionId ?? undefined,
      inApp: true,
    });
    return c.json({ comment }, 201);
  });

  routes.delete("/:id/comments/:commentId", (c) => {
    service.deleteComment(c.req.param("id"), c.req.param("commentId"), currentUser(c).id);
    return c.body(null, 204);
  });

  routes.get("/:id/entries", (c) => c.json(service.entries(c.req.param("id"), viewer(c))));

  routes.put("/:id/entries", async (c) => {
    const body = await readJson(c);
    if (typeof body.key !== "string") {
      throw new ServiceError("INVALID_INPUT", "Send the entry's `key` as a string.");
    }
    const entry = service.setEntry(c.req.param("id"), {
      authorId: currentUser(c).id,
      key: body.key,
      value: body.value,
    });
    return c.json({ entry });
  });

  // The key goes in the query: keys hold characters such as `:` and `/`.
  routes.delete("/:id/entries", (c) => {
    const key = c.req.query("key");
    if (key === undefined) throw new ServiceError("INVALID_INPUT", "Name the entry with ?key=.");
    service.clearEntry(c.req.param("id"), { authorId: currentUser(c).id, key });
    return c.body(null, 204);
  });

  routes.get("/:id/markdown", async (c) => {
    const { markdown, empty, source, converterVersion, generatedAt } = await service.markdown(
      c.req.param("id"),
      viewer(c),
      c.req.query("version") ?? null,
    );
    return c.json({ markdown, empty, source, converterVersion, generatedAt });
  });

  routes.get("/:id/source", async (c) => {
    const { version, content } = await service.source(
      c.req.param("id"),
      viewer(c),
      c.req.query("version") ?? null,
    );
    // The bytes are untrusted HTML. This origin serves them as an opaque
    // download; the isolated content host is what renders them.
    // The DOM BodyInit type does not accept Uint8Array<ArrayBufferLike>, which
    // is what a Bun file read returns, though every runtime sends it correctly.
    return new Response(content as unknown as BodyInit, {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": contentDisposition(version.originalFilename),
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      },
    });
  });

  return routes;
}

/**
 * The upload endpoint an MCP client uses instead of putting a whole document in
 * a tool argument. It takes a signed ticket, not a session: the client that
 * sends the bytes is a shell command, and it has no cookie to send.
 */
export function uploadRoutes(service: ArtifactService, secret: string): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.post("/", async (c) => {
    const header = c.req.header("authorization") ?? "";
    const prefix = header.slice(0, 7).toLowerCase();
    const ticket = prefix === "bearer " ? header.slice(7).trim() : "";

    const result = verifyUploadTicket(secret, ticket);
    // The reason stays on the server, as it does for a preview link. A caller
    // learns only that this ticket does not work.
    if (!result.valid) {
      throw new ServiceError(
        "UNAUTHENTICATED",
        "This upload ticket is not valid or has expired. Ask for a new one.",
      );
    }

    const uploaded = await uploadFromForm(c, service, result.userId, { inApp: false });
    return c.json(uploaded, 201);
  });

  return routes;
}

/**
 * One multipart upload, whatever decided who the creator is. A session and a
 * ticket answer that question differently and agree on everything after it.
 */
async function uploadFromForm(
  c: Context<AppEnv>,
  service: ArtifactService,
  createdBy: string,
  options: { inApp: boolean },
): Promise<UploadResult> {
  const declared = Number(c.req.header("content-length") ?? "0");
  if (declared > maxUploadRequestBytes(service)) {
    throw new ServiceError(
      "FILE_TOO_LARGE",
      `The upload is larger than the ${service.maxUploadBytes} byte limit for the document plus the ${service.maxImageBytesTotal} byte limit for images.`,
    );
  }

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    throw new ServiceError("INVALID_INPUT", "The upload is not a valid multipart form.");
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new ServiceError(
      "INVALID_INPUT",
      "Attach the HTML or Markdown document as the `file` field.",
    );
  }
  const contentType = readField(form, "contentType") ?? "html";
  if (contentType !== "html" && contentType !== "markdown") {
    throw new ServiceError("INVALID_INPUT", "contentType must be html or markdown.");
  }

  const images = [];
  for (const image of form.getAll("image")) {
    if (!(image instanceof File)) {
      throw new ServiceError("INVALID_INPUT", "Attach each image as a file in an `image` field.");
    }
    // The filename is the name the HTML uses in images/<name>. The service
    // checks it; it never becomes a path on disk.
    images.push({ name: image.name, bytes: new Uint8Array(await image.arrayBuffer()) });
  }

  return service.upload({
    bytes: new Uint8Array(await file.arrayBuffer()),
    contentType,
    // Multipart text fields arrive with CRLF line endings whatever was sent.
    markdown: readField(form, "markdown")?.replaceAll("\r\n", "\n") ?? null,
    filename: file.name,
    title: readField(form, "title"),
    description: readField(form, "description"),
    artifactId: readField(form, "artifactId"),
    allowDuplicateTitle: readField(form, "allowDuplicateTitle") === "true",
    ...(form.has("folderId") ? { folderId: form.get("folderId") } : {}),
    ...(form.has("tagId") ? { tagIds: form.getAll("tagId") } : {}),
    ...(form.has("visibility") ? { visibility: form.get("visibility") } : {}),
    images,
    createdBy,
    inApp: options.inApp,
  });
}

export async function readJson(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    if (!body || typeof body !== "object") throw new Error("not an object");
    return body as Record<string, unknown>;
  } catch {
    throw new ServiceError("INVALID_INPUT", "Send a JSON object.");
  }
}

function readField(form: FormData, name: string): string | null {
  const value = form.get(name);
  return typeof value === "string" ? value : null;
}
