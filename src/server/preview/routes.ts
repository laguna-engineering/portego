import { type Context, Hono } from "hono";
import { ServiceError } from "../artifacts/errors.ts";
import { isImageName } from "../artifacts/images.ts";
import type { ArtifactService } from "../artifacts/service.ts";
import { withBridge } from "./bridge.ts";
import { previewHeaders, previewImageHeaders } from "./headers.ts";
import { type PreviewSubject, verifyPreviewToken } from "./tokens.ts";

export type PreviewOptions = {
  service: ArtifactService;
  secret: string;
  /** Origin allowed to frame a preview. */
  appOrigin: string;
  /** Origin this content host answers on. Image URLs in the policy are built from it. */
  contentOrigin: string;
};

const PLAIN_HEADERS = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
};

/**
 * The only routes the content host serves. They take a signed token, not a
 * session: the content host never receives an application cookie, and these
 * routes never read one.
 */
export function previewRoutes(options: PreviewOptions): Hono {
  const routes = new Hono();

  const verify = (c: Context): PreviewSubject | Response => {
    const result = verifyPreviewToken(options.secret, c.req.param("token") ?? "");
    // The reason stays on the server. A caller learns only that this URL
    // does not work, never whether the artifact exists.
    if (!result.valid) {
      return c.text("This preview link is not valid or has expired.", 403, PLAIN_HEADERS);
    }
    return result;
  };

  const unavailable = (c: Context, error: unknown): Response => {
    if (error instanceof ServiceError) {
      return c.text(
        "This artifact is not available.",
        error.code === "NOT_FOUND" ? 404 : 500,
        PLAIN_HEADERS,
      );
    }
    throw error;
  };

  const page = async (c: Context) => {
    const subject = verify(c);
    if (subject instanceof Response) return subject;

    try {
      const { content } = await options.service.source(subject.artifactId, subject.versionId);
      // The response declares UTF-8, so the browser reads the upload as UTF-8
      // whichever way it was written. Decoding it the same way here changes
      // nothing about what the browser sees.
      const html = new TextDecoder().decode(content);
      const imagesBase = `${options.contentOrigin}/preview/${c.req.param("token")}/images/`;
      return new Response(withBridge(html), {
        headers: previewHeaders(options.appOrigin, imagesBase),
      });
    } catch (error) {
      return unavailable(c, error);
    }
  };

  // The issuer hands out the form with a trailing slash. The bare form stays
  // valid for a document with no images.
  routes.get("/:token", page);
  routes.get("/:token/", page);

  routes.get("/:token/images/:name", async (c) => {
    const subject = verify(c);
    if (subject instanceof Response) return subject;

    const name = c.req.param("name");
    if (!isImageName(name)) return c.text("No such image.", 404, PLAIN_HEADERS);

    try {
      const image = await options.service.image(subject.artifactId, subject.versionId, name);
      // The DOM BodyInit type does not accept Uint8Array<ArrayBufferLike>, which
      // is what a Bun file read returns, though every runtime sends it correctly.
      return new Response(image.content as unknown as BodyInit, {
        headers: previewImageHeaders(image.contentType),
      });
    } catch (error) {
      return unavailable(c, error);
    }
  });

  return routes;
}
