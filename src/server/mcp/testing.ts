/**
 * Drives the OAuth flow an MCP client performs, against a live test server.
 * Nothing here is a shortcut: the client registers, authorizes with PKCE, the
 * user consents, and the code is exchanged for a token.
 */
import type { LiveTestServer } from "../testing.ts";

export type McpClient = {
  accessToken: string;
  refreshToken?: string;
  scope: string;
  call: (body: unknown, init?: { token?: string }) => Promise<Response>;
};

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = crypto.randomUUID().replaceAll("-", "").repeat(2);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: Buffer.from(digest).toString("base64url") };
}

export async function registerClient(
  server: LiveTestServer,
  cookie: string,
  scope = "artifacts:read artifacts:write",
  grantTypes = ["authorization_code"],
): Promise<string> {
  const response = await fetch(`${server.origin}/api/auth/oauth2/create-client`, {
    method: "POST",
    headers: { cookie, origin: server.origin, "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Test MCP client",
      redirect_uris: ["https://client.test/callback"],
      token_endpoint_auth_method: "none",
      grant_types: grantTypes,
      scope,
    }),
  });
  const body = (await response.json()) as { client_id: string };
  return body.client_id;
}

/** Completes the browser flow and returns a client holding an access token. */
export async function authorizeClient(
  server: LiveTestServer,
  options: {
    cookie: string;
    clientId: string;
    scope?: string;
    accept?: boolean;
    redirectUri?: string;
  },
): Promise<McpClient> {
  const scope = options.scope ?? "artifacts:read artifacts:write";
  const redirectUri = options.redirectUri ?? "https://client.test/callback";
  const { verifier, challenge } = await pkce();

  const query = new URLSearchParams({
    response_type: "code",
    client_id: options.clientId,
    redirect_uri: redirectUri,
    scope,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${server.origin}/mcp`,
    state: "state-value",
  });

  const authorize = await fetch(`${server.origin}/api/auth/oauth2/authorize?${query}`, {
    headers: { cookie: options.cookie },
    redirect: "manual",
  });
  const location = authorize.headers.get("location");
  if (!location) throw new Error(`Authorization did not redirect: ${authorize.status}`);

  const consent = await fetch(`${server.origin}/api/auth/oauth2/consent`, {
    method: "POST",
    headers: { cookie: options.cookie, origin: server.origin, "content-type": "application/json" },
    body: JSON.stringify({
      accept: options.accept ?? true,
      oauth_query: new URL(location, server.origin).search,
    }),
  });
  const consentBody = (await consent.json()) as { url?: string; redirect_uri?: string };
  const redirect = consentBody.url ?? consentBody.redirect_uri;
  if (!redirect) throw new Error(`Consent returned no redirect: ${JSON.stringify(consentBody)}`);

  const code = new URL(redirect).searchParams.get("code");
  if (!code) throw new Error(`Consent produced no code: ${redirect}`);

  const token = await fetch(`${server.origin}/api/auth/oauth2/token`, {
    method: "POST",
    headers: { origin: server.origin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: options.clientId,
      code_verifier: verifier,
      resource: `${server.origin}/mcp`,
    }),
  });
  const tokenBody = (await token.json()) as {
    access_token?: string;
    refresh_token?: string;
    scope?: string;
  };
  if (!tokenBody.access_token) {
    throw new Error(`Token request failed: ${JSON.stringify(tokenBody)}`);
  }

  return {
    accessToken: tokenBody.access_token,
    refreshToken: tokenBody.refresh_token,
    scope: tokenBody.scope ?? "",
    call: (body, init) =>
      fetch(`${server.origin}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${init?.token ?? tokenBody.access_token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(body),
      }),
  };
}

export type ToolResult = {
  result?: { structuredContent?: Record<string, unknown>; isError?: boolean; content?: unknown[] };
  error?: { message: string };
};

export async function callTool(
  client: McpClient,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  const response = await client.call({
    jsonrpc: "2.0",
    id: Math.floor(Math.random() * 1e6),
    method: "tools/call",
    params: { name, arguments: args },
  });
  return (await response.json()) as ToolResult;
}
