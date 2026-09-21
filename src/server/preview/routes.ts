import { Hono } from "hono";
import { ServiceError } from "../artifacts/errors.ts";
import type { ArtifactService } from "../artifacts/service.ts";
import { withBridge } from "./bridge.ts";
import { previewHeaders } from "./headers.ts";
import { verifyPreviewToken } from "./tokens.ts";

export type PreviewOptions = {
  service: ArtifactService;
  secret: string;
  /** Origin allowed to frame a preview. */
  appOrigin: string;
};

/**
 * The only route the content host serves. It takes a signed token, not a
 * session: the content host never receives an application cookie, and this
 * route never reads one.
 */
export function previewRoutes(options: PreviewOptions): Hono {
  const routes = new Hono();

  routes.get("/:token", async (c) => {
    const result = verifyPreviewToken(options.secret, c.req.param("token"));
    if (!result.valid) {
      // The reason stays on the server. A caller learns only that this URL
      // does not work, never whether the artifact exists.
      return c.text("This preview link is not valid or has expired.", 403, {
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      });
    }

    try {
      const { content } = await options.service.source(result.artifactId, result.versionId);
      // The response declares UTF-8, so the browser reads the upload as UTF-8
      // whichever way it was written. Decoding it the same way here changes
      // nothing about what the browser sees.
      const html = new TextDecoder().decode(content);
      return new Response(withBridge(html), {
        headers: previewHeaders(options.appOrigin),
      });
    } catch (error) {
      if (error instanceof ServiceError) {
        return c.text("This artifact is not available.", error.code === "NOT_FOUND" ? 404 : 500, {
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
        });
      }
      throw error;
    }
  });

  return routes;
}
