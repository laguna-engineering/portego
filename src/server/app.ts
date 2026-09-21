import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { artifactRoutes, handleServiceError, uploadRoutes } from "./artifacts/routes.ts";
import type { ArtifactService } from "./artifacts/service.ts";
import { createUploadTicketIssuer } from "./artifacts/tickets.ts";
import type { Auth } from "./auth/auth.ts";
import { type AuthConfig, publicProviders } from "./auth/config.ts";
import {
  type AppEnv,
  attachSession,
  currentUser,
  requireSameOrigin,
  requireUser,
} from "./auth/middleware.ts";
import type { EventBus } from "./events/bus.ts";
import { eventRoutes } from "./events/routes.ts";
import { createPrincipalResolver } from "./mcp/principal.ts";
import { createMcpHandler } from "./mcp/routes.ts";
import { previewRoutes } from "./preview/routes.ts";
import { createPreviewIssuer } from "./preview/tokens.ts";

export type AppOptions = {
  /** Serve the built Vite client from disk. Off in development, where Vite serves it. */
  serveClient: boolean;
  clientDist: string;
  auth: Auth;
  authConfig: AuthConfig;
  artifacts: ArtifactService;
  /** Origin that serves artifact previews. Must be a different host from the app. */
  contentOrigin: string;
  /** Signs preview tokens and upload tickets. Each derives its own key from it. */
  signingSecret: string;
  /** Announces committed changes to connected clients. */
  events: EventBus;
};

export function createApp(options: AppOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const appOrigin = new URL(options.authConfig.baseURL).origin;
  const contentHost = new URL(options.contentOrigin).host;

  // One process answers both hostnames. The content host serves previews and
  // nothing else: no auth, no API, no application, no directory listing. The
  // application host serves no preview, so uploaded HTML never renders on the
  // origin that holds the session cookie.
  app.use("*", async (c, next) => {
    const isPreview = c.req.path.startsWith("/preview/");
    // The Fetch API keeps the Host header out of Headers, so the request URL
    // is where the hostname the client asked for can be read.
    const onContentHost = new URL(c.req.url).host.toLowerCase() === contentHost.toLowerCase();
    if (onContentHost !== isPreview) return c.text("Not found", 404);
    await next();
  });

  app.route(
    "/preview",
    previewRoutes({ service: options.artifacts, secret: options.signingSecret, appOrigin }),
  );

  app.get("/healthz", (c) => c.json({ status: "ok", uptime: Math.round(process.uptime()) }));

  app.use("/api/*", requireSameOrigin(options.authConfig.baseURL));

  // OAuth discovery lives at the root of the host, which is where a client
  // looks for it. Better Auth serves these documents itself.
  app.get("/.well-known/*", (c) => options.auth.handler(c.req.raw));

  const mcp = createMcpHandler({
    auth: options.auth,
    service: options.artifacts,
    resource: options.authConfig.mcp.resource,
    webUrl: (id) => `${appOrigin}/a/${encodeURIComponent(id)}`,
    issueUploadTicket: createUploadTicketIssuer({ secret: options.signingSecret, appOrigin }),
    resolvePrincipal: createPrincipalResolver({
      auth: options.auth,
      admission: options.authConfig.admission,
    }),
    allowedHosts: [new URL(options.authConfig.baseURL).host],
    allowedOrigins: [appOrigin],
  });
  app.all("/mcp", (c) => mcp(c.req.raw));

  // Sign-in, sign-out, the OAuth callback, and the session endpoint. Better
  // Auth reads the session itself, so this route answers before the session
  // middleware below and never looks it up twice.
  app.on(["GET", "POST"], "/api/auth/*", (c) => options.auth.handler(c.req.raw));

  app.use("/api/*", attachSession(options.auth));

  // The sign-in page renders whatever the deployment enabled. No provider is
  // named in client code.
  app.get("/api/auth-providers", (c) => c.json({ providers: publicProviders(options.authConfig) }));

  // The client's first call: who is signed in, and the limits it needs to
  // check an upload before sending it.
  app.get("/api/me", requireUser, (c) => {
    const { id, name, email, image } = currentUser(c);
    return c.json({
      user: { id, name, email, image: image ?? null },
      limits: { maxUploadBytes: options.artifacts.maxUploadBytes },
    });
  });

  // Upload by ticket rather than by session. It is registered outside the
  // artifact routes because every route in there requires a session, and the
  // client that sends these bytes is a shell command with no cookie.
  app.route("/api/uploads", uploadRoutes(options.artifacts, options.signingSecret));

  // The change stream. It is registered before the artifact routes only for
  // readability; Hono matches on the path.
  app.route("/api/events", eventRoutes({ bus: options.events }));

  app.route(
    "/api/artifacts",
    artifactRoutes(
      options.artifacts,
      createPreviewIssuer({
        secret: options.signingSecret,
        contentOrigin: options.contentOrigin,
      }),
    ),
  );

  // Every failure leaves through the same shape, including one nobody planned
  // for. A stack trace never reaches the client.
  app.onError(handleServiceError);

  if (options.serveClient) {
    const root = options.clientDist;
    app.use("/assets/*", serveStatic({ root }));
    // Keep unknown API and asset paths a 404. The catch-all below answers every
    // other path with index.html so the client router can handle deep links.
    // A stale index.html naming a removed hashed asset would otherwise receive
    // HTML with status 200, and the browser would fail parsing it as JavaScript.
    app.all("/api/*", (c) => c.notFound());
    app.all("/assets/*", (c) => c.notFound());
    app.get("*", serveStatic({ path: `${root}/index.html` }));
  }

  return app;
}
