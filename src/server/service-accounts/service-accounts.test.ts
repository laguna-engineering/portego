import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { signIn } from "../auth/testing.ts";
import { authorizeClient, registerClient } from "../mcp/testing.ts";
import {
  createLiveTestServer,
  createTestServer,
  type LiveTestServer,
  WORKSPACE_USER,
} from "../testing.ts";
import { ACCOUNT_LIFETIME_MS, MAX_PENDING_ENROLLMENTS } from "./service.ts";
import {
  accessToken,
  agentKey,
  approve,
  callMcp,
  enroll,
  enrolledAgent,
  LIST_TOOLS,
  poll,
  renew,
  requestToken,
  sign,
} from "./testing.ts";

const ADMIN = {
  sub: "google-admin",
  email: "admin@acme.example",
  email_verified: true,
  name: "An Admin",
};

let server: LiveTestServer;
let adminCookie: string;
let memberCookie: string;
/** Added to the service account clock, to move past an expiry. */
let offset = 0;

beforeAll(async () => {
  server = await createLiveTestServer({
    serviceAccounts: true,
    admins: [ADMIN.email],
    now: () => Date.now() + offset,
  });
  adminCookie = await server.signIn(ADMIN);
  memberCookie = await server.signIn(WORKSPACE_USER);
});

afterAll(() => {
  server.stop();
});

function uploadArtifact(token: string, title: string) {
  return callMcp(server, token, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "upload_artifact",
      arguments: { title, html: "<!doctype html><html><title>t</title>hi</html>" },
    },
  });
}

describe("signing in as an agent", () => {
  // The whole point of the feature: an agent reaches /mcp with no browser.
  test("an approved key gets a token that /mcp accepts as the service account", async () => {
    const agent = await enrolledAgent(server, adminCookie);
    const token = await accessToken(server, agent);

    expect((await callMcp(server, token, LIST_TOOLS)).status).toBe(200);
    const uploaded = (await (await uploadArtifact(token, "From an agent")).json()) as {
      result: { structuredContent: { id: string } };
    };
    const artifact = server.artifacts.get(uploaded.result.structuredContent.id, {
      userId: agent.userId,
    });
    expect(artifact.creator.id).toBe(agent.userId);
    expect(artifact.creator.name).toBe("Review runner");
  });

  test("an enrollment poll without the key's signature does not return the client id", async () => {
    const key = await agentKey();
    const { id } = (await (await enroll(server, key)).json()) as { id: string };
    expect((await approve(server, adminCookie, id)).status).toBe(200);

    const unsigned = await fetch(`${server.origin}/api/service-accounts/enrollments/${id}`);
    expect(unsigned.status).toBe(401);
    const other = await poll(server, id, (await agentKey()).privateKey);
    expect(other.status).toBe(401);
    expect(await other.text()).not.toContain("clientId");

    const owner = (await (await poll(server, id, key.privateKey)).json()) as { status: string };
    expect(owner.status).toBe("approved");
  });

  test("a poll before approval says pending", async () => {
    const key = await agentKey();
    const { id } = (await (await enroll(server, key)).json()) as { id: string };
    expect(await (await poll(server, id, key.privateKey)).json()).toEqual({ status: "pending" });
  });

  test("refuses a key that is not an Ed25519 public key", async () => {
    const key = await agentKey();
    for (const publicJwk of [
      { ...key.publicJwk, d: key.publicJwk.x },
      { kty: "EC", crv: "P-256", x: key.publicJwk.x },
      "not a key",
    ]) {
      const response = await fetch(`${server.origin}/api/service-accounts/enrollments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Agent", publicJwk }),
      });
      expect(response.status).toBe(400);
    }
  });
});

describe("approval", () => {
  test("only an admin can review, approve, list, or disable", async () => {
    const key = await agentKey();
    const { id } = (await (await enroll(server, key)).json()) as { id: string };
    const asMember = { cookie: memberCookie, origin: server.origin };

    const review = await fetch(`${server.origin}/api/service-accounts/enrollments/${id}/approval`, {
      headers: asMember,
    });
    expect(review.status).toBe(403);
    expect((await approve(server, memberCookie, id)).status).toBe(403);
    expect(
      (await fetch(`${server.origin}/api/service-accounts`, { headers: asMember })).status,
    ).toBe(403);
    expect(await (await poll(server, id, key.privateKey)).json()).toEqual({ status: "pending" });
  });

  test("shows the admin the code and the key's thumbprint", async () => {
    const key = await agentKey();
    const created = (await (await enroll(server, key)).json()) as {
      id: string;
      userCode: string;
      approvalUrl: string;
    };
    expect(created.approvalUrl).toBe(
      `${server.origin}/settings/service-accounts/approve/${created.id}`,
    );
    const review = (await (
      await fetch(`${server.origin}/api/service-accounts/enrollments/${created.id}/approval`, {
        headers: { cookie: adminCookie },
      })
    ).json()) as { enrollment: { userCode: string; thumbprint: string; name: string } };
    expect(review.enrollment.userCode).toBe(created.userCode);
    expect(review.enrollment.userCode).toMatch(/^[B-DF-HJ-NP-TV-XZ]{8}$/);
    expect(review.enrollment.thumbprint).toBeString();
    expect(review.enrollment.name).toBe("Review runner");
  });

  test("an enrollment cannot be approved twice", async () => {
    const key = await agentKey();
    const { id } = (await (await enroll(server, key)).json()) as { id: string };
    expect((await approve(server, adminCookie, id)).status).toBe(200);
    expect((await approve(server, adminCookie, id)).status).toBe(404);
  });

  // The endpoint takes no authentication, so the table must not grow without bound.
  test(`refuses more than ${MAX_PENDING_ENROLLMENTS} enrollments waiting at once`, async () => {
    const isolated = await createLiveTestServer({ serviceAccounts: true, admins: [ADMIN.email] });
    try {
      const statuses: number[] = [];
      for (let index = 0; index <= MAX_PENDING_ENROLLMENTS; index += 1) {
        statuses.push((await enroll(isolated, await agentKey())).status);
      }
      expect(statuses.slice(0, MAX_PENDING_ENROLLMENTS).every((status) => status === 201)).toBe(
        true,
      );
      expect(statuses.at(-1)).toBe(429);
    } finally {
      isolated.stop();
    }
  });
});

describe("renewal", () => {
  // This is what makes a copied key stop working.
  test("a key replaced by renewal can no longer get a token", async () => {
    const agent = await enrolledAgent(server, adminCookie);
    const next = await agentKey();
    expect((await renew(server, agent, next)).status).toBe(200);

    const stale = await requestToken(server, agent.clientId, agent.key.privateKey);
    expect(stale.body.error).toBe("invalid_client");
    expect((await requestToken(server, agent.clientId, next.privateKey)).status).toBe(200);
  });

  // A stolen access token must not outlive the key it was minted with.
  test("an access token issued before a renewal is refused after it", async () => {
    const agent = await enrolledAgent(server, adminCookie);
    const before = await accessToken(server, agent);
    // `iat` has whole seconds. Renewing in a later second puts the old token
    // strictly before the renewal.
    await Bun.sleep(1100);
    const next = await agentKey();
    expect((await renew(server, agent, next)).status).toBe(200);

    expect((await callMcp(server, before, LIST_TOOLS)).status).toBe(403);
    const after = await accessToken(server, { ...agent, key: next });
    expect((await callMcp(server, after, LIST_TOOLS)).status).toBe(200);
  });

  // A stolen access token must not be able to take over the account.
  test("refuses an access token in place of the key's assertion", async () => {
    const agent = await enrolledAgent(server, adminCookie);
    const token = await accessToken(server, agent);
    const response = await fetch(`${server.origin}/api/service-accounts/renew`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        clientId: agent.clientId,
        publicJwk: (await agentKey()).publicJwk,
        assertion: token,
      }),
    });
    expect(response.status).toBe(401);
    expect((await requestToken(server, agent.clientId, agent.key.privateKey)).status).toBe(200);
  });

  test("refuses a replayed renewal assertion", async () => {
    const agent = await enrolledAgent(server, adminCookie);
    const url = `${server.origin}/api/service-accounts/renew`;
    const assertion = await sign(agent.key.privateKey, {
      iss: agent.clientId,
      sub: agent.clientId,
      aud: url,
    });
    // A renewal that succeeds replaces the key, so its replay fails on the
    // signature alone. One refused for keeping the key still spends the jti.
    expect((await renew(server, agent, agent.key, assertion)).status).toBe(400);
    expect((await renew(server, agent, await agentKey(), assertion)).status).toBe(401);
  });

  // Two renewals signed by the same old key: only one may install its key.
  test("two renewals with the same key leave exactly one new key", async () => {
    const agent = await enrolledAgent(server, adminCookie);
    const [first, second] = [await agentKey(), await agentKey()];
    const responses = await Promise.all([
      renew(server, agent, first),
      renew(server, agent, second),
    ]);
    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([200, 401]);

    const results = await Promise.all([
      requestToken(server, agent.clientId, first.privateKey),
      requestToken(server, agent.clientId, second.privateKey),
    ]);
    expect(results.map((result) => result.status).filter((status) => status === 200)).toHaveLength(
      1,
    );
  });

  test("an assertion that lives longer than a minute is refused", async () => {
    const agent = await enrolledAgent(server, adminCookie);
    const assertion = await sign(agent.key.privateKey, {
      iss: agent.clientId,
      sub: agent.clientId,
      aud: `${server.origin}/api/service-accounts/renew`,
      lifetimeSeconds: 600,
    });
    expect((await renew(server, agent, await agentKey(), assertion)).status).toBe(401);
  });
});

describe("revocation", () => {
  // Revocation must take effect without waiting for the hour-long token to expire.
  test("a disabled account is refused at /mcp, at the token endpoint, and at renewal", async () => {
    const agent = await enrolledAgent(server, adminCookie);
    const token = await accessToken(server, agent);

    const disabled = await fetch(`${server.origin}/api/service-accounts/${agent.userId}/disable`, {
      method: "POST",
      headers: { cookie: adminCookie, origin: server.origin },
    });
    expect(disabled.status).toBe(200);

    expect((await callMcp(server, token, LIST_TOOLS)).status).toBe(403);
    expect((await requestToken(server, agent.clientId, agent.key.privateKey)).body.error).toBe(
      "invalid_client",
    );
    const renewal = await renew(server, agent, await agentKey());
    expect(renewal.status).toBe(401);
    expect(((await renewal.json()) as { error: { code: string } }).error.code).toBe(
      "INVALID_CLIENT",
    );
  });

  test("an account not renewed for a week is refused at /mcp and at renewal", async () => {
    const agent = await enrolledAgent(server, adminCookie);
    const token = await accessToken(server, agent);
    offset = ACCOUNT_LIFETIME_MS + 1000;
    try {
      expect((await callMcp(server, token, LIST_TOOLS)).status).toBe(403);
      expect((await renew(server, agent, await agentKey())).status).toBe(401);
    } finally {
      offset = 0;
    }
  });

  test("an admin can re-enroll a disabled account with a new key", async () => {
    const agent = await enrolledAgent(server, adminCookie);
    await fetch(`${server.origin}/api/service-accounts/${agent.userId}/disable`, {
      method: "POST",
      headers: { cookie: adminCookie, origin: server.origin },
    });

    const again = await enrolledAgent(server, adminCookie, { accountId: agent.userId });
    expect(again.userId).toBe(agent.userId);
    expect(again.clientId).toBe(agent.clientId);
    expect((await callMcp(server, await accessToken(server, again), LIST_TOOLS)).status).toBe(200);
    expect((await requestToken(server, agent.clientId, agent.key.privateKey)).status).toBe(401);
  });
});

describe("keeping agents and people apart", () => {
  test("a service account's user cannot get a browser session", async () => {
    const agent = await enrolledAgent(server, adminCookie);
    // An address the email policy admits, so only the service account check
    // stands between a sign-in with that address and this user's session.
    const email = `agent-${agent.clientId}@acme.example`;
    server.database
      .query(`update "user" set email = ?, emailVerified = 1 where id = ?`)
      .run(email, agent.userId);

    const response = await signIn(server.auth, {
      sub: `google-${agent.clientId}`,
      email,
      email_verified: true,
    });
    expect(response.headers.get("set-cookie") ?? "").not.toContain("session_token=");
    expect(
      server.database.query("select * from session where userId = ?").all(agent.userId),
    ).toEqual([]);
  });

  test("a person's token is resolved as that person even when its subject is a client id", async () => {
    const agent = await enrolledAgent(server, adminCookie);
    const person = await authorizeClient(server, {
      cookie: memberCookie,
      clientId: await registerClient(server, memberCookie),
    });
    expect((await callMcp(server, person.accessToken, LIST_TOOLS)).status).toBe(200);

    const resolve = (await import("../mcp/principal.ts")).createPrincipalResolver({
      auth: server.auth,
      admission: { kind: "email-domains", domains: ["acme.example"] },
      serviceAccounts: server.serviceAccounts,
    });
    const claims = JSON.parse(
      Buffer.from(person.accessToken.split(".")[1] ?? "", "base64url").toString(),
    ) as Record<string, unknown>;
    const personId = String(claims.sub);
    // A token with a session takes the person path, whatever its subject is.
    expect(await resolve({ ...claims, sub: agent.clientId, azp: agent.clientId })).toBeNull();
    expect(await resolve(claims)).toEqual({ userId: personId });
  });

  // Nobody can take over a service account through Google or OIDC.
  test("sign-in with the service account's address is refused, even under open admission", async () => {
    const open = await createTestServer({
      serviceAccounts: true,
      admins: [ADMIN.email],
      allowAll: true,
    });
    try {
      await open.signIn(ADMIN);
      const service = open.serviceAccounts;
      if (!service) throw new Error("service accounts are off");
      const key = await agentKey();
      const enrollment = await service.enroll({ name: "Agent", publicJwk: key.publicJwk });
      const adminId = (
        open.database.query(`select id from "user" where email = ?`).get(ADMIN.email) as {
          id: string;
        }
      ).id;
      const account = service.approve(enrollment.id, { kind: "member" }, adminId);
      const userRow = () =>
        open.database.query(`select * from "user" where id = ?`).get(account.userId);
      const before = userRow();

      const takeover = await signIn(open.auth, {
        sub: "google-attacker",
        email: `${account.clientId}@service.invalid`,
        email_verified: true,
      });
      expect(takeover.headers.get("set-cookie") ?? "").not.toContain("session_token=");
      // Nothing was linked to the service account's user, and it is unchanged.
      expect(
        open.database.query("select * from account where userId = ?").all(account.userId),
      ).toEqual([]);
      expect(userRow()).toEqual(before);
      const fresh = await signIn(open.auth, {
        sub: "google-other",
        email: "someone@service.invalid",
        email_verified: true,
      });
      expect(fresh.headers.get("set-cookie") ?? "").not.toContain("session_token=");
    } finally {
      open.cleanup();
    }
  });
});

describe("with SERVICE_ACCOUNTS unset", () => {
  test("the routes do not exist and a client_credentials token is refused", async () => {
    const off = await createLiveTestServer({ admins: [ADMIN.email] });
    try {
      for (const [method, path] of [
        ["POST", "/api/service-accounts/enrollments"],
        ["GET", "/api/service-accounts/enrollments/x"],
        ["POST", "/api/service-accounts/renew"],
        ["GET", "/api/service-accounts"],
      ] as const) {
        const response = await fetch(`${off.origin}${path}`, {
          method,
          headers: { "content-type": "application/json" },
          ...(method === "POST" ? { body: "{}" } : {}),
        });
        expect(response.status, path).toBe(404);
      }

      const cookie = await off.signIn(WORKSPACE_USER);
      const me = (await (await fetch(`${off.origin}/api/me`, { headers: { cookie } })).json()) as {
        features: { serviceAccounts: boolean };
      };
      expect(me.features.serviceAccounts).toBe(false);

      // A client row written while the feature was on still mints a token,
      // and /mcp refuses it, because no person has that id.
      const agent = await enrolledAgent(server, adminCookie);
      const ownerId = (off.database.query(`select id from "user"`).get() as { id: string }).id;
      const { insertOAuthClient } = await import("../storage/service-accounts.ts");
      insertOAuthClient(
        off.database,
        {
          clientId: agent.clientId,
          userId: ownerId,
          name: "Agent",
          jwks: JSON.stringify({ keys: [agent.key.publicJwk] }),
          resource: `${off.origin}/mcp`,
        },
        Date.now(),
      );
      const token = await accessToken(off, agent);
      expect((await callMcp(off, token, LIST_TOOLS)).status).toBe(403);
    } finally {
      off.stop();
    }
  });
});

describe("the session endpoint", () => {
  test("tells an admin that service accounts are on", async () => {
    const me = (await (
      await fetch(`${server.origin}/api/me`, { headers: { cookie: adminCookie } })
    ).json()) as { user: { admin: boolean }; features: { serviceAccounts: boolean } };
    expect(me.user.admin).toBe(true);
    expect(me.features.serviceAccounts).toBe(true);

    const member = (await (
      await fetch(`${server.origin}/api/me`, { headers: { cookie: memberCookie } })
    ).json()) as { user: { admin: boolean } };
    expect(member.user.admin).toBe(false);
  });
});
