/**
 * Proves the Better Auth behaviour that service accounts rely on. Portego
 * writes the OAuth client row itself, because Better Auth's admin endpoints
 * need a session and cannot replace a key. These tests fail when an upgrade
 * changes that row's shape or the token endpoint's rules.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import { authorizeClient, registerClient } from "../mcp/testing.ts";
import { insertOAuthClient } from "../storage/service-accounts.ts";
import { createLiveTestServer, type LiveTestServer } from "../testing.ts";

let server: LiveTestServer;
let cookie: string;
let ownerId: string;

beforeAll(async () => {
  server = await createLiveTestServer();
  cookie = await server.signIn();
  const owner = server.database.query(`select id from "user"`).get() as { id: string };
  ownerId = owner.id;
});

afterAll(() => {
  server.stop();
});

type KeyPair = { privateKey: CryptoKey; publicJwk: JWK };

async function keyPair(): Promise<KeyPair> {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
  return { privateKey, publicJwk: await exportJWK(publicKey) };
}

async function client(): Promise<{ clientId: string } & KeyPair> {
  const clientId = crypto.randomUUID();
  const keys = await keyPair();
  insertOAuthClient(
    server.database,
    {
      clientId,
      userId: ownerId,
      name: "Step zero agent",
      jwks: JSON.stringify({ keys: [keys.publicJwk] }),
      resource: `${server.origin}/mcp`,
    },
    Date.now(),
  );
  return { clientId, ...keys };
}

function assertion(clientId: string, key: CryptoKey): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "EdDSA" })
    .setIssuer(clientId)
    .setSubject(clientId)
    .setAudience(`${server.origin}/api/auth/oauth2/token`)
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .setExpirationTime("60s")
    .sign(key);
}

async function requestToken(
  clientId: string,
  signed: string,
  options: { resource?: boolean } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${server.origin}/api/auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: signed,
      scope: "artifacts:read artifacts:write",
      ...(options.resource === false ? {} : { resource: `${server.origin}/mcp` }),
    }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function claimsOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString());
}

function callMcp(token: string): Promise<Response> {
  return fetch(`${server.origin}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

describe("client_credentials with private_key_jwt", () => {
  test("issues a JWT for the MCP audience whose subject is the client", async () => {
    const { clientId, privateKey, publicJwk } = await client();
    expect(Object.keys(publicJwk).sort()).toEqual(["crv", "kty", "x"]);

    const { status, body } = await requestToken(clientId, await assertion(clientId, privateKey));
    expect(status, JSON.stringify(body)).toBe(200);
    expect(body.refresh_token).toBeUndefined();

    const token = String(body.access_token);
    expect(token.split(".")).toHaveLength(3);
    const claims = claimsOf(token);
    expect(claims.sub).toBe(clientId);
    expect(claims.azp).toBe(clientId);
    expect(claims.client_id).toBe(clientId);
    expect(claims.aud).toBe(`${server.origin}/mcp`);
    expect("sid" in claims).toBe(false);

    // With service accounts off, the principal resolver finds no user for
    // this subject and answers 403. A token that failed verification gets 401.
    expect((await callMcp(token)).status).toBe(403);
  });

  test("issues an opaque token, which /mcp refuses, when no resource is named", async () => {
    const { clientId, privateKey } = await client();
    const { status, body } = await requestToken(clientId, await assertion(clientId, privateKey), {
      resource: false,
    });
    expect(status).toBe(200);
    const token = String(body.access_token);
    expect(token.split(".")).not.toHaveLength(3);
    expect((await callMcp(token)).status).toBe(401);
  });

  test("refuses the MCP resource to a client that is not linked to it", async () => {
    const { clientId, privateKey } = await client();
    server.database.query("delete from oauthClientResource where clientId = ?").run(clientId);
    const { status, body } = await requestToken(clientId, await assertion(clientId, privateKey));
    expect(status).toBe(400);
    expect(body.error).toBe("invalid_target");
  });

  test("reads the client row on every request, so a key or flag change applies at once", async () => {
    const first = await client();
    const { clientId } = first;
    expect((await requestToken(clientId, await assertion(clientId, first.privateKey))).status).toBe(
      200,
    );

    const second = await keyPair();
    server.database
      .query("update oauthClient set jwks = ? where clientId = ?")
      .run(JSON.stringify({ keys: [second.publicJwk] }), clientId);
    const stale = await requestToken(clientId, await assertion(clientId, first.privateKey));
    expect(stale.body.error).toBe("invalid_client");
    expect(
      (await requestToken(clientId, await assertion(clientId, second.privateKey))).status,
    ).toBe(200);

    server.database.query("update oauthClient set disabled = 1 where clientId = ?").run(clientId);
    const disabled = await requestToken(clientId, await assertion(clientId, second.privateKey));
    expect(disabled.body.error).toBe("invalid_client");
  });

  test("refuses a replayed assertion", async () => {
    const { clientId, privateKey } = await client();
    const signed = await assertion(clientId, privateKey);
    expect((await requestToken(clientId, signed)).status).toBe(200);
    const replay = await requestToken(clientId, signed);
    expect(replay.body.error).toBe("invalid_client");
    expect(replay.body.error_description).toContain("already been used");
  });

  test("keeps Better Auth's own key rotation endpoint off", async () => {
    const response = await fetch(`${server.origin}/api/auth/oauth2/client/rotate-keys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_assertion: "x",
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        jwks: { keys: [(await keyPair()).publicJwk] },
      }),
    });
    expect(response.status).toBe(403);
  });
});

describe("the client row Portego writes", () => {
  // Better Auth's registration endpoint is the reference for every column
  // Portego does not set on purpose.
  test("matches the row Better Auth's registration endpoint writes", async () => {
    const { publicJwk } = await keyPair();
    const response = await fetch(`${server.origin}/api/auth/oauth2/create-client`, {
      method: "POST",
      headers: { cookie, origin: server.origin, "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Reference",
        token_endpoint_auth_method: "private_key_jwt",
        grant_types: ["client_credentials"],
        jwks: { keys: [publicJwk] },
        scope: "artifacts:read artifacts:write",
      }),
    });
    expect(response.status).toBe(201);
    const reference = (await response.json()) as { client_id: string };
    const ours = await client();

    const row = (clientId: string) =>
      server.database.query("select * from oauthClient where clientId = ?").get(clientId) as Record<
        string,
        unknown
      >;
    const ignored = [
      "id",
      "clientId",
      "createdAt",
      "updatedAt",
      "userId",
      "name",
      "jwks",
      // Only Better Auth's admin endpoint sets this, and it needs a session.
      "clientCredentialsScopes",
    ];
    const comparable = (values: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(values).filter(([key]) => !ignored.includes(key)));
    expect(comparable(row(ours.clientId))).toEqual(comparable(row(reference.client_id)));
    expect(row(ours.clientId).clientCredentialsScopes).toBe(
      JSON.stringify(["artifacts:read", "artifacts:write"]),
    );

    const links = (clientId: string) =>
      server.database
        .query("select resourceId from oauthClientResource where clientId = ?")
        .all(clientId);
    expect(links(ours.clientId)).toEqual(links(reference.client_id));
  });

  // A person's client cannot mint tokens of its own: its scope ceiling is
  // empty, because only the admin endpoint can set one.
  test("leaves a person's client_credentials client without tokens", async () => {
    const { privateKey, publicJwk } = await keyPair();
    const response = await fetch(`${server.origin}/api/auth/oauth2/create-client`, {
      method: "POST",
      headers: { cookie, origin: server.origin, "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Self-made",
        token_endpoint_auth_method: "private_key_jwt",
        grant_types: ["client_credentials"],
        jwks: { keys: [publicJwk] },
        scope: "artifacts:read artifacts:write",
      }),
    });
    const { client_id: clientId } = (await response.json()) as { client_id: string };
    const { body } = await requestToken(clientId, await assertion(clientId, privateKey));
    expect(body.error).toBe("unauthorized_client");
  });
});

describe("a person's token", () => {
  // The resolver tells the two kinds of token apart by `sid`.
  test("carries a session id from the code grant and from the refresh grant", async () => {
    const scope = "artifacts:read artifacts:write offline_access";
    const clientId = await registerClient(server, cookie, scope, [
      "authorization_code",
      "refresh_token",
    ]);
    const person = await authorizeClient(server, { cookie, clientId, scope });
    expect(claimsOf(person.accessToken).sid).toBeString();

    const response = await fetch(`${server.origin}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { origin: server.origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: person.refreshToken ?? "",
        client_id: clientId,
        resource: `${server.origin}/mcp`,
      }),
    });
    const refreshed = (await response.json()) as { access_token: string };
    const claims = claimsOf(refreshed.access_token);
    expect(claims.sid).toBeString();
    expect(claims.sub).not.toBe(claims.azp);
  });
});
