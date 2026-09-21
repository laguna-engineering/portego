/**
 * The metadata fetch is the one request the server makes to a host that an
 * unauthenticated client chose. These tests cover what keeps that host from
 * costing the server anything: HTTPS only, no redirects, a deadline, and a
 * byte ceiling enforced while the body arrives rather than after it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createClientMetadataFetch, fetchClientMetadataResource } from "./client-metadata.ts";

const CLIENT_ID = "https://client.test/metadata.json";

let original: typeof fetch;
let seen: RequestInit | undefined;

/** Answers every request with `body`, and records the init it was given. */
function stubFetch(body: BodyInit, init: ResponseInit = {}): void {
  globalThis.fetch = ((_input: RequestInfo | URL, requestInit?: RequestInit) => {
    seen = requestInit;
    return Promise.resolve(new Response(body, init));
  }) as typeof fetch;
}

/** Never answers. The request ends only when its signal aborts. */
function stubHangingFetch(): void {
  globalThis.fetch = ((_input: RequestInfo | URL, requestInit?: RequestInit) => {
    seen = requestInit;
    return new Promise((_resolve, reject) => {
      requestInit?.signal?.addEventListener("abort", () => reject(requestInit.signal?.reason));
    });
  }) as typeof fetch;
}

beforeEach(() => {
  original = globalThis.fetch;
  seen = undefined;
});

afterEach(() => {
  globalThis.fetch = original;
});

describe("fetching a client metadata document", () => {
  test("refuses a client id that is not served over HTTPS", async () => {
    stubFetch("{}");

    await expect(fetchClientMetadataResource("http://client.test/metadata.json")).rejects.toThrow(
      /HTTPS/,
    );
    expect(seen).toBeUndefined();
  });

  test("returns a document that is within the limit", async () => {
    stubFetch(JSON.stringify({ client_id: CLIENT_ID }), { status: 200 });

    const response = await fetchClientMetadataResource(CLIENT_ID);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ client_id: CLIENT_ID });
  });

  test("follows no redirect and asks for JSON", async () => {
    stubFetch("{}");

    await fetchClientMetadataResource(CLIENT_ID);
    expect(seen?.redirect).toBe("error");
    expect(new Headers(seen?.headers).get("accept")).toBe("application/json");
  });

  test("keeps the caller's revalidation headers", async () => {
    stubFetch("{}");

    // Better Auth sends these to turn a repeat fetch into a 304. Dropping them
    // would make every cache revalidation download the document again.
    await fetchClientMetadataResource(CLIENT_ID, {
      headers: new Headers({ "if-none-match": '"abc"' }),
    });
    expect(new Headers(seen?.headers).get("if-none-match")).toBe('"abc"');
  });

  test("keeps the caller's own abort signal alive beside the deadline", async () => {
    stubFetch("{}");
    const caller = new AbortController();

    await fetchClientMetadataResource(CLIENT_ID, { signal: caller.signal });
    expect(seen?.signal?.aborted).toBe(false);

    caller.abort();
    expect(seen?.signal?.aborted).toBe(true);
  });

  test("gives up on a host that never answers", async () => {
    stubHangingFetch();

    const error = await createClientMetadataFetch({ timeoutMs: 25 })(CLIENT_ID).catch(
      (cause: unknown) => cause,
    );
    expect((error as Error).name).toBe("TimeoutError");
  });

  test("stops an oversized response while it arrives instead of buffering it", async () => {
    // Four times the ceiling, in sixteen chunks. A reader that buffers first
    // pulls all sixteen; a bounded one gives up after roughly four.
    const limit = 64 * 1024;
    const chunks = 16;
    let produced = 0;
    let cancelled = false;
    stubFetch(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (produced === chunks) {
            controller.close();
            return;
          }
          produced += 1;
          controller.enqueue(new Uint8Array(limit / 4));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );

    await expect(createClientMetadataFetch({ maxBytes: limit })(CLIENT_ID)).rejects.toThrow(
      /too large/,
    );
    expect(produced).toBeLessThan(chunks);
    expect(cancelled).toBe(true);
  });
});
