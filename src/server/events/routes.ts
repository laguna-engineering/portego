import { Hono } from "hono";
import { type AppEnv, currentUser, requireUser } from "../auth/middleware.ts";
import type { ChangeEvent, EventBus } from "./bus.ts";

/**
 * How often the stream writes a comment line. A proxy or a phone radio drops a
 * connection that says nothing for long enough, and the write is what tells
 * the server the client has gone.
 */
export const HEARTBEAT_MS = 20_000;

/** How long a client waits before reconnecting. Sent once, on the stream. */
const RETRY_MS = 3_000;

/**
 * One stream per open page is the expected shape. The per-user limit leaves
 * room for several tabs; the total limit is what stops one client from holding
 * every connection the process has.
 */
export const MAX_STREAMS_PER_USER = 8;
export const MAX_STREAMS = 200;

export type EventRouteOptions = {
  bus: EventBus;
  heartbeatMs?: number;
  maxPerUser?: number;
  maxTotal?: number;
};

export function eventRoutes(options: EventRouteOptions): Hono<AppEnv> {
  const { bus } = options;
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  const maxPerUser = options.maxPerUser ?? MAX_STREAMS_PER_USER;
  const maxTotal = options.maxTotal ?? MAX_STREAMS;

  const perUser = new Map<string, number>();
  let total = 0;

  const routes = new Hono<AppEnv>();
  routes.use("*", requireUser);

  routes.get("/", (c) => {
    const user = currentUser(c);
    const held = perUser.get(user.id) ?? 0;
    if (total >= maxTotal || held >= maxPerUser) {
      return c.json(
        { error: { code: "TOO_MANY_STREAMS", message: "Too many open connections." } },
        503,
      );
    }

    total += 1;
    perUser.set(user.id, held + 1);

    const encoder = new TextEncoder();
    let unsubscribe = () => {};
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let release = () => {};

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let open = true;

        // Every write goes through here. A client that disappears without a
        // clean close makes the next enqueue throw, and that is the signal to
        // let the subscription and the interval go.
        const write = (chunk: string) => {
          if (!open) return;
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            release();
          }
        };

        release = () => {
          if (!open) return;
          open = false;
          unsubscribe();
          if (heartbeat !== null) clearInterval(heartbeat);
          heartbeat = null;
          total -= 1;
          const remaining = (perUser.get(user.id) ?? 1) - 1;
          if (remaining > 0) perUser.set(user.id, remaining);
          else perUser.delete(user.id);
          try {
            controller.close();
          } catch {
            // Already closed by the client going away. Nothing left to do.
          }
        };

        write(`retry: ${RETRY_MS}\n\n`);
        heartbeat = setInterval(() => write(": keep-alive\n\n"), heartbeatMs);
        unsubscribe = bus.subscribe((event: ChangeEvent) => {
          write(`data: ${JSON.stringify(event)}\n\n`);
        });

        // A closed tab aborts the request. Without this the subscription would
        // outlive the reader and the count would never come back down.
        c.req.raw.signal.addEventListener("abort", () => release(), { once: true });
      },

      cancel() {
        release();
      },
    });

    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        // nginx buffers a proxied response by default, which would hold every
        // event until the buffer filled. The location block turns buffering
        // off; this header says the same thing from the application, so a
        // deployment behind a proxy nobody edited still delivers on time.
        "X-Accel-Buffering": "no",
      },
    });
  });

  return routes;
}
