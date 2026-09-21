/**
 * Fetches an MCP client's metadata document.
 *
 * The client id is a URL the client chose, so this request goes wherever that
 * URL points. It is restricted to HTTPS, follows no redirects, gives up
 * quickly, and refuses a document larger than a client metadata document has
 * any reason to be.
 */
const TIMEOUT_MS = 5000;
const MAX_BYTES = 64 * 1024;

/**
 * Reads at most `limit` bytes and cancels the stream as soon as the response
 * goes over. The host is client-chosen and unauthenticated, so an oversized
 * body is refused while it arrives, never after it is all in memory.
 */
async function readBounded(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!stream) return new Uint8Array(0);

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("The client metadata document is too large");
      chunks.push(value);
    }
  } finally {
    // Releases the connection. On the oversized path this is what stops the
    // sender, and it runs before the error reaches the caller.
    await reader.cancel().catch(() => undefined);
  }

  const body = new Uint8Array(new ArrayBuffer(size));
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export type ClientMetadataFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/** The limits are arguments so a test can reach them without waiting on them. */
export function createClientMetadataFetch(
  options: { timeoutMs?: number; maxBytes?: number } = {},
): ClientMetadataFetch {
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_BYTES;

  return async function fetchClientMetadataResource(input, init) {
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (url.protocol !== "https:") {
      throw new Error("A client metadata document must be served over HTTPS");
    }

    // The caller's own signal still aborts the request. The timeout is an
    // additional upper bound on it, not a replacement for it.
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;

    // A Headers instance has no enumerable own properties, so spreading it
    // would drop the caller's revalidation headers.
    const headers = new Headers(init?.headers);
    headers.set("accept", "application/json");

    const response = await fetch(url, { ...init, redirect: "error", signal, headers });

    const body = await readBounded(response.body, maxBytes);
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

export const fetchClientMetadataResource = createClientMetadataFetch();
