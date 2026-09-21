import type { Artifact } from "./api.ts";
import type { LiveEvent } from "./live.ts";

export type StubResponse = { status?: number; body?: unknown };

export type Handler = (path: string, init?: RequestInit) => StubResponse;

const original = globalThis.fetch;

/** Answers the client's API calls from a table, with no network. */
export function stubFetch(handler: Handler): void {
  stubFetchWith((path, init) => {
    const { status = 200, body = {} } = handler(path, init);
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  });
}

/** For a test that needs to control when the response arrives. */
export function stubFetchWith(
  handler: (path: string, init?: RequestInit) => Promise<Response>,
): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    handler(typeof input === "string" ? input : input.toString(), init)) as unknown as typeof fetch;
}

export function restoreFetch(): void {
  globalThis.fetch = original;
}

export function artifact(overrides: Partial<Artifact> = {}): Artifact {
  const id = overrides.id ?? "artifact-1";
  return {
    id,
    title: "Sales chart",
    description: "Q3 by region",
    originalFilename: "chart.html",
    sha256: "a".repeat(64),
    byteSize: 2048,
    creator: { id: "user-1", name: "A Person", email: "person@acme.example" },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "open",
    archivedAt: null,
    versionCount: 1,
    currentVersionId: id,
    ...overrides,
  };
}

export function htmlFile(name = "chart.html", size = 1024): File {
  return new File(["<!doctype html><html><title>t</title></html>".padEnd(size, " ")], name, {
    type: "text/html",
  });
}

/**
 * happy-dom has no EventSource, so one lives here. It records what was opened
 * and lets a test push an event or a failure the way the server would.
 */
export class StubEventSource {
  static open: StubEventSource[] = [];

  readonly url: string;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    StubEventSource.open.push(this);
  }

  close() {
    this.closed = true;
    StubEventSource.open = StubEventSource.open.filter((other) => other !== this);
  }

  /** The connection is established. */
  connect() {
    this.onopen?.();
  }

  /** The server announced something. */
  send(event: LiveEvent) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }

  /** The connection dropped. The real one retries by itself after this. */
  fail() {
    this.onerror?.();
  }

  static get last(): StubEventSource | undefined {
    return StubEventSource.open.at(-1);
  }

  static install() {
    StubEventSource.open = [];
    (globalThis as Record<string, unknown>).EventSource = StubEventSource;
  }
}
