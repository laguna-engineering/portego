/** Drives the agent's side of a service account against a live test server. */
import { calculateJwkThumbprint, exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import type { LiveTestServer } from "../testing.ts";

export type AgentKey = { privateKey: CryptoKey; publicJwk: JWK };

export async function agentKey(): Promise<AgentKey> {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
  return { privateKey, publicJwk: await exportJWK(publicKey) };
}

export function sign(
  key: CryptoKey,
  claims: {
    iss: string;
    sub?: string;
    aud: string;
    jti?: string;
    lifetimeSeconds?: number;
    nextJkt?: string;
  },
): Promise<string> {
  const jwt = new SignJWT(claims.nextJkt === undefined ? {} : { next_jkt: claims.nextJkt })
    .setProtectedHeader({ alg: "EdDSA" })
    .setIssuer(claims.iss)
    .setAudience(claims.aud)
    .setIssuedAt()
    .setExpirationTime(`${claims.lifetimeSeconds ?? 30}s`);
  if (claims.sub !== undefined) jwt.setSubject(claims.sub);
  jwt.setJti(claims.jti ?? crypto.randomUUID());
  return jwt.sign(key);
}

export async function enroll(
  server: LiveTestServer,
  key: AgentKey,
  name = "Review runner",
): Promise<Response> {
  return fetch(`${server.origin}/api/service-accounts/enrollments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, publicJwk: key.publicJwk }),
  });
}

export async function poll(server: LiveTestServer, id: string, key: CryptoKey): Promise<Response> {
  const url = `${server.origin}/api/service-accounts/enrollments/${id}`;
  return fetch(url, {
    headers: { authorization: `Bearer ${await sign(key, { iss: id, aud: url })}` },
  });
}

export async function approve(
  server: LiveTestServer,
  adminCookie: string,
  id: string,
  body: Record<string, unknown> = {},
): Promise<Response> {
  return fetch(`${server.origin}/api/service-accounts/enrollments/${id}/approval`, {
    method: "POST",
    headers: { cookie: adminCookie, origin: server.origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export type Agent = { clientId: string; userId: string; key: AgentKey };

/** Enrolls a new key, has the admin approve it, and polls for the client id. */
export async function enrolledAgent(
  server: LiveTestServer,
  adminCookie: string,
  approval: Record<string, unknown> = {},
  key?: AgentKey,
): Promise<Agent> {
  const agent = key ?? (await agentKey());
  const enrollment = (await (await enroll(server, agent)).json()) as { id: string };
  const approved = await approve(server, adminCookie, enrollment.id, approval);
  if (approved.status !== 200) throw new Error(`Approval failed: ${await approved.text()}`);
  const { account } = (await approved.json()) as { account: { id: string } };
  const polled = (await (await poll(server, enrollment.id, agent.privateKey)).json()) as {
    clientId: string;
  };
  return { clientId: polled.clientId, userId: account.id, key: agent };
}

export async function requestToken(
  server: LiveTestServer,
  clientId: string,
  key: CryptoKey,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const tokenUrl = `${server.origin}/api/auth/oauth2/token`;
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: await sign(key, { iss: clientId, sub: clientId, aud: tokenUrl }),
      resource: `${server.origin}/mcp`,
      scope: "artifacts:read artifacts:write",
    }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

export async function accessToken(server: LiveTestServer, agent: Agent): Promise<string> {
  const { status, body } = await requestToken(server, agent.clientId, agent.key.privateKey);
  if (status !== 200) throw new Error(`Token request failed: ${JSON.stringify(body)}`);
  return String(body.access_token);
}

/** Signed by the agent's current key, naming `next` as the key that replaces it. */
export async function renewalAssertion(
  server: LiveTestServer,
  agent: { clientId: string; key: AgentKey },
  next: AgentKey,
): Promise<string> {
  return sign(agent.key.privateKey, {
    iss: agent.clientId,
    sub: agent.clientId,
    aud: `${server.origin}/api/service-accounts/renew`,
    nextJkt: await calculateJwkThumbprint(next.publicJwk),
  });
}

export async function renew(
  server: LiveTestServer,
  agent: { clientId: string; key: AgentKey },
  next: AgentKey,
  assertion?: string,
): Promise<Response> {
  return fetch(`${server.origin}/api/service-accounts/renew`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      clientId: agent.clientId,
      publicJwk: next.publicJwk,
      assertion: assertion ?? (await renewalAssertion(server, agent, next)),
    }),
  });
}

export function callMcp(server: LiveTestServer, token: string, body: unknown): Promise<Response> {
  return fetch(`${server.origin}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
}

export const LIST_TOOLS = { jsonrpc: "2.0", id: 1, method: "tools/list" };
