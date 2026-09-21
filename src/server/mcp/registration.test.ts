/**
 * Client ID Metadata Documents are the supported way for a remote MCP client
 * to register: the client id is an HTTPS URL and the server reads the document
 * it points at. Dynamic registration is off, so this is the path that has to
 * work, and the one whose refusals have to hold.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createLiveTestServer, type LiveTestServer } from "../testing.ts";
import { authorizeClient, callTool } from "./testing.ts";

const CLIENT_ORIGIN = "https://client.test";

let server: LiveTestServer;
let cookie: string;
let realFetch: typeof fetch;
let fetched: string[] = [];
/** Answers the client's own origin. Everything else goes to the real network. */
let serveClientOrigin: (url: string) => Response;

function metadataDocument(clientId: string): Record<string, unknown> {
  return {
    client_id: clientId,
    client_name: "Metadata document client",
    redirect_uris: [`${CLIENT_ORIGIN}/callback`],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    response_types: ["code"],
    scope: "artifacts:read artifacts:write",
  };
}

/** Starts the browser half of the flow and returns where it went. */
async function authorize(clientId: string): Promise<Response> {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: `${CLIENT_ORIGIN}/callback`,
    scope: "artifacts:read",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
    resource: `${server.origin}/mcp`,
    state: "state-value",
  });
  return realFetch(`${server.origin}/api/auth/oauth2/authorize?${query}`, {
    headers: { cookie },
    redirect: "manual",
  });
}

beforeAll(async () => {
  server = await createLiveTestServer();
  cookie = await server.signIn();

  realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (!url.startsWith(CLIENT_ORIGIN)) return realFetch(input, init);
    fetched.push(url);
    return Promise.resolve(serveClientOrigin(url));
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  server.stop();
});

beforeEach(() => {
  fetched = [];
  // Cacheable, as a real document is: the server reads it once and reuses it
  // for the rest of the flow.
  serveClientOrigin = (url) => Response.json(metadataDocument(url));
});

describe("registration by metadata document", () => {
  test("authorizes a client whose id is the URL of its metadata document", async () => {
    const clientId = `${CLIENT_ORIGIN}/metadata.json`;

    const client = await authorizeClient(server, { cookie, clientId });
    expect(fetched).toContain(clientId);

    // The token is a real one: it reaches the MCP endpoint and reads artifacts.
    const result = await callTool(client, "list_artifacts");
    expect(result.result?.isError ?? false).toBe(false);
  });

  test("authorizes a loopback client on the port it is listening on", async () => {
    // A client that runs on the machine binds a port it does not know in
    // advance, so its metadata document registers the portless loopback URI
    // and the request carries the port. RFC 8252 says the port does not take
    // part in the match. Claude Code is one such client, and a server that
    // matches the port refuses every one of its sign-ins.
    const clientId = `${CLIENT_ORIGIN}/loopback.json`;
    serveClientOrigin = (url) =>
      Response.json({ ...metadataDocument(url), redirect_uris: ["http://localhost/callback"] });

    const client = await authorizeClient(server, {
      cookie,
      clientId,
      redirectUri: "http://localhost:54220/callback",
    });

    const result = await callTool(client, "list_artifacts");
    expect(result.result?.isError ?? false).toBe(false);
  });

  test("refuses a metadata document larger than a metadata document needs to be", async () => {
    const clientId = `${CLIENT_ORIGIN}/oversized.json`;
    // 256 KiB, four times the ceiling. The fetch gives up part way through it.
    serveClientOrigin = (url) =>
      Response.json({ ...metadataDocument(url), padding: "x".repeat(256 * 1024) });

    const response = await authorize(clientId);
    expect(fetched).toContain(clientId);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_client" });
  });

  test("refuses a metadata document that answers with a redirect", async () => {
    const clientId = `${CLIENT_ORIGIN}/moved.json`;
    serveClientOrigin = () =>
      new Response(null, { status: 302, headers: { location: `${CLIENT_ORIGIN}/elsewhere.json` } });

    const response = await authorize(clientId);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_client" });
  });
});
