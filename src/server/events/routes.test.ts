import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../auth/middleware.ts";
import { TEST_BASE_URL } from "../auth/testing.ts";
import { createLiveTestServer, createTestServer, htmlFile } from "../testing.ts";
import { createEventBus, type EventBus } from "./bus.ts";
import { eventRoutes } from "./routes.ts";

const USER = { id: "user-1", name: "A Person", email: "person@acme.example" };

/** The stream route with a session already in place, so limits can be set. */
function streamApp(options: { bus: EventBus; heartbeatMs?: number; maxPerUser?: number }) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("user", USER as never);
    c.set("session", null);
    await next();
  });
  app.route("/api/events", eventRoutes(options));
  return app;
}

/**
 * Reads from an open stream until `wanted` matches, or gives up. A test that
 * waited on a stream forever would hang the suite rather than fail.
 */
async function readUntil(res: Response, wanted: RegExp, timeoutMs = 2000): Promise<string> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let seen = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const next = await Promise.race([
        reader.read(),
        Bun.sleep(deadline - Date.now()).then(() => "timeout" as const),
      ]);
      if (next === "timeout" || (typeof next === "object" && next.done)) break;
      if (typeof next === "object" && next.value) seen += decoder.decode(next.value);
      if (wanted.test(seen)) return seen;
    }
  } finally {
    await reader.cancel();
  }
  throw new Error(`Stream never matched ${wanted}. Saw: ${JSON.stringify(seen)}`);
}

describe("the change stream", () => {
  test("announces a change to a client that is already listening", async () => {
    const bus = createEventBus();
    const app = streamApp({ bus });
    const res = await app.request("/api/events");

    bus.publish({ type: "artifact.created", id: "artifact-1" });

    const seen = await readUntil(res, /artifact\.created/);
    expect(seen).toContain('data: {"type":"artifact.created","id":"artifact-1"}');
  });

  test("tells the proxy and the browser not to hold or store the stream", async () => {
    const app = streamApp({ bus: createEventBus() });
    const res = await app.request("/api/events");

    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-store");
    // nginx buffers a proxied response by default, which would delay every event.
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    await res.body?.cancel();
  });

  test("keeps writing while idle, so an idle proxy does not drop the connection", async () => {
    const app = streamApp({ bus: createEventBus(), heartbeatMs: 10 });
    const res = await app.request("/api/events");

    expect(await readUntil(res, /: keep-alive/)).toContain(": keep-alive");
  });

  test("refuses a client that opens more streams than it could be using", async () => {
    const bus = createEventBus();
    const app = streamApp({ bus, maxPerUser: 2 });

    const first = await app.request("/api/events");
    const second = await app.request("/api/events");
    const third = await app.request("/api/events");

    expect(third.status).toBe(503);
    expect(await third.json()).toMatchObject({ error: { code: "TOO_MANY_STREAMS" } });
    expect(bus.size).toBe(2);

    await first.body?.cancel();
    await second.body?.cancel();
  });

  test("gives the slot back when a client goes away, so a tab cycle is not fatal", async () => {
    const bus = createEventBus();
    const app = streamApp({ bus, maxPerUser: 1 });

    const first = await app.request("/api/events");
    expect((await app.request("/api/events")).status).toBe(503);

    await first.body?.cancel();
    expect(bus.size).toBe(0);

    const reopened = await app.request("/api/events");
    expect(reopened.status).toBe(200);
    await reopened.body?.cancel();
  });
});

describe("the change stream in the application", () => {
  test("is closed to anyone without a session", async () => {
    const server = await createTestServer();
    try {
      const res = await server.app.request("/api/events");
      expect(res.status).toBe(401);
    } finally {
      server.cleanup();
    }
  });

  test("carries an upload made over the API to a listening client", async () => {
    const server = await createTestServer();
    try {
      const cookie = await server.signIn();
      const res = await server.app.request("/api/events", { headers: { cookie } });
      expect(res.status).toBe(200);

      const form = new FormData();
      form.set("file", htmlFile("<h1>A chart</h1>", "chart.html"));
      const upload = await server.app.request("/api/artifacts", {
        method: "POST",
        headers: { cookie, origin: TEST_BASE_URL },
        body: form,
      });
      const { artifact } = (await upload.json()) as { artifact: { id: string } };

      const seen = await readUntil(res, /artifact\.created/);
      expect(seen).toContain(artifact.id);
    } finally {
      server.cleanup();
    }
  });
});

/**
 * The tests above call the router directly, which proves what the handler
 * writes. This one goes over a socket, which proves the bytes leave the
 * process before the response ends. A stream held in a buffer until close
 * would pass every test above and deliver nothing in a browser.
 */
describe("the change stream over a connection", () => {
  test("delivers an event while the response is still open", async () => {
    const server = await createLiveTestServer();
    try {
      const cookie = await server.signIn();
      const res = await fetch(`${server.origin}/api/events`, { headers: { cookie } });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      const form = new FormData();
      form.set("file", htmlFile("<h1>A chart</h1>", "chart.html"));
      await fetch(`${server.origin}/api/artifacts`, {
        method: "POST",
        headers: { cookie, origin: server.origin },
        body: form,
      });

      const seen = await readUntil(res, /artifact\.created/);
      expect(seen).toContain("artifact.created");
    } finally {
      server.stop();
    }
  });

  test("keeps delivering after longer than the server's idle timeout", async () => {
    // Bun closes a quiet connection after its idle timeout, and a proxy may not
    // pass that on, leaving a client that never hears another event. Bun checks
    // timeouts every 4 seconds, so a one-second timeout fires within that.
    const server = await createLiveTestServer({ idleTimeout: 1 });
    try {
      const cookie = await server.signIn();
      const res = await fetch(`${server.origin}/api/events`, { headers: { cookie } });
      expect(res.status).toBe(200);
      await Bun.sleep(5000);

      server.events.publish({ type: "entry.changed", artifactId: "quiet" });

      expect(await readUntil(res, /entry\.changed/)).toContain("quiet");
    } finally {
      server.stop();
    }
  }, 10_000);

  test("lets go of the subscription when the client disconnects", async () => {
    const server = await createLiveTestServer();
    try {
      const cookie = await server.signIn();
      const abort = new AbortController();
      const res = await fetch(`${server.origin}/api/events`, {
        headers: { cookie },
        signal: abort.signal,
      });

      // Read one chunk and leave the stream open. Cancelling the reader here
      // would release the subscription by the tidy path and prove nothing
      // about a client that simply went away.
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      await reader.read();
      expect(server.events.size).toBe(1);

      abort.abort();
      await Bun.sleep(50);

      expect(server.events.size).toBe(0);
    } finally {
      server.stop();
    }
  });
});
