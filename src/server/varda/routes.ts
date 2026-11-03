import { createHmac, timingSafeEqual } from "node:crypto";
import { requireMcpAuth } from "@better-auth/mcp";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { JWTPayload } from "jose";
import { z } from "zod";
import type { Auth } from "../auth/auth.ts";
import type { AppEnv } from "../auth/middleware.ts";
import { HEARTBEAT_MS } from "../events/routes.ts";
import type { ResolvePrincipal } from "../mcp/routes.ts";
import type { VardaOutbox, VardaRow } from "../storage/varda-outbox.ts";

/** A pull_request event is a few tens of KiB; GitHub would send up to 25 MB. */
export const WEBHOOK_MAX_BYTES = 1024 * 1024;

/**
 * Rows are deleted after this even when Varda never acknowledged them. It is
 * also the refresh token's lifetime: a Varda away longer signs in again and
 * sweeps every open PR at startup.
 */
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const RETRY_MS = 3_000;

const ackBody = z.object({ ids: z.array(z.int().positive()).min(1).max(1000) });

export type VardaOptions = {
  /** The user id of Varda's account. */
  account: string;
  /** The GitHub App's webhook secret. Without it, the GitHub endpoint does not exist. */
  webhookSecret?: string;
  outbox: VardaOutbox;
  /** The clock for retention and token expiry. Tests move it. */
  now?: () => number;
};

/** The Varda integration's routes, mounted only when it is on. docs/varda-integration.md. */
export function vardaRoutes(
  options: VardaOptions & {
    auth: Auth;
    /** The MCP URL: Varda sends the token it uses there, so this is its audience. */
    resource: string;
    resolvePrincipal: ResolvePrincipal;
  },
) {
  const routes = new Hono<AppEnv>();
  const secret = options.webhookSecret;
  const { outbox } = options;
  const now = options.now ?? Date.now;
  let closeStream: (() => void) | null = null;

  // Only a bearer token counts: a request with a session cookie and no token
  // gets 401. The admission policy runs again on the token's user.
  const asVarda = (
    c: Context<AppEnv>,
    handler: (request: Request, claims: JWTPayload) => Promise<Response>,
  ) =>
    requireMcpAuth(
      options.auth,
      async (request, claims) => {
        const principal = await options.resolvePrincipal(claims);
        if (principal?.userId !== options.account) {
          return c.json(
            { error: { code: "FORBIDDEN", message: "Only Varda's account can use this." } },
            403,
          );
        }
        return handler(request, claims);
      },
      { resource: options.resource, requiredScopes: ["artifacts:read"] },
    )(c.req.raw);

  // Every unacknowledged row, then each new row. Last-Event-ID is ignored:
  // jobs for different PRs finish out of order, so a row below the last id
  // Varda saw can still be unacknowledged.
  routes.get("/stream", (c) =>
    asVarda(c, async (request, claims) => {
      outbox.prune(now() - RETENTION_MS);
      // One stream at a time: a new one closes the one before it.
      closeStream?.();
      // See events/routes.ts: Bun's idle timeout would close the stream.
      (c.env as { timeout?: (request: Request, seconds: number) => void } | undefined)?.timeout?.(
        c.req.raw,
        0,
      );

      const encoder = new TextEncoder();
      let release = () => {};
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          let open = true;
          let unsubscribe = () => {};
          let heartbeat: ReturnType<typeof setInterval> | null = null;
          let expiry: ReturnType<typeof setTimeout> | null = null;
          release = () => {
            if (!open) return;
            open = false;
            unsubscribe();
            if (heartbeat !== null) clearInterval(heartbeat);
            if (expiry !== null) clearTimeout(expiry);
            if (closeStream === release) closeStream = null;
            try {
              controller.close();
            } catch {
              // Already closed by the client going away.
            }
          };
          const write = (chunk: string) => {
            if (!open) return;
            try {
              controller.enqueue(encoder.encode(chunk));
            } catch {
              release();
            }
          };
          const send = (row: VardaRow) => write(`id: ${row.id}\ndata: ${row.data}\n\n`);
          closeStream = release;

          write(`retry: ${RETRY_MS}\n\n`);
          // One synchronous block: no row can be announced between the
          // subscription and the backlog read, so none is missed or sent twice.
          unsubscribe = outbox.onRow(send);
          for (const row of outbox.backlog()) send(row);
          heartbeat = setInterval(() => write(": keep-alive\n\n"), HEARTBEAT_MS);
          // Varda refreshes the token and connects again.
          if (typeof claims.exp === "number") {
            expiry = setTimeout(release, Math.max(0, claims.exp * 1000 - now()));
          }
          request.signal.addEventListener("abort", release, { once: true });
        },
        cancel() {
          release();
        },
      });

      return new Response(body, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Accel-Buffering": "no",
        },
      });
    }),
  );

  routes.post("/ack", (c) =>
    asVarda(c, async (request) => {
      const parsed = ackBody.safeParse(await request.json().catch(() => null));
      if (!parsed.success) {
        return c.json(
          {
            error: {
              code: "INVALID_INPUT",
              message: 'Send {"ids": [...]}: 1 to 1000 positive integers.',
            },
          },
          400,
        );
      }
      outbox.remove(parsed.data.ids);
      outbox.prune(now() - RETENTION_MS);
      return c.body(null, 204);
    }),
  );

  // GitHub's signature is the only authentication. GitHub sends no cookie, so
  // the same-origin check on /api lets the request through.
  if (secret !== undefined) {
    routes.post(
      "/github",
      bodyLimit({
        maxSize: WEBHOOK_MAX_BYTES,
        onError: (c) =>
          c.json({ error: { code: "FILE_TOO_LARGE", message: "The event is too large." } }, 413),
      }),
      async (c) => {
        const body = Buffer.from(await c.req.arrayBuffer());
        if (!signedBy(secret, body, c.req.header("X-Hub-Signature-256"))) {
          return c.json(
            { error: { code: "UNAUTHENTICATED", message: "The signature does not match." } },
            401,
          );
        }
        // ping and every other event are acknowledged and dropped.
        if (c.req.header("X-GitHub-Event") !== "pull_request") return c.body(null, 204);
        const data = pullRequestRow(body);
        if (data === null) {
          console.error(
            "Varda integration: a signed pull_request event without the expected fields",
          );
          return c.body(null, 204);
        }
        const id = options.outbox.insert(data, c.req.header("X-GitHub-Delivery"));
        if (id !== null) options.outbox.announce({ id, data });
        return c.body(null, 204);
      },
    );
  }

  return routes;
}

function signedBy(secret: string, body: Buffer, header: string | undefined): boolean {
  if (header === undefined) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The row data for a pull_request event, or null when a field is missing. */
function pullRequestRow(body: Buffer): string | null {
  let event: unknown;
  try {
    event = JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
  if (typeof event !== "object" || event === null) return null;
  const payload = event as {
    action?: unknown;
    repository?: { full_name?: unknown };
    pull_request?: { number?: unknown; head?: { sha?: unknown } };
  };
  const action = payload.action;
  const repo = payload.repository?.full_name;
  const pr = payload.pull_request?.number;
  const head = payload.pull_request?.head?.sha;
  if (
    typeof action !== "string" ||
    typeof repo !== "string" ||
    typeof pr !== "number" ||
    typeof head !== "string"
  ) {
    return null;
  }
  return JSON.stringify({
    type: "github",
    event: "pull_request",
    action,
    repo,
    pr,
    head,
    at: new Date().toISOString(),
  });
}
