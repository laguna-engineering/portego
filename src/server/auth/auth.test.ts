import { describe, expect, test } from "bun:test";
import { createTestAuth, signIn } from "./testing.ts";

const workspaceUser = {
  sub: "google-subject-1",
  email: "person@acme.example",
  email_verified: true,
  hd: "acme.example",
  name: "A Person",
};

function userCount(database: { query: (sql: string) => { get: () => unknown } }): number {
  const row = database.query("select count(*) as count from user").get() as { count: number };
  return row.count;
}

describe("sign-in admission", () => {
  test("admits a Workspace identity in the allowed domain", async () => {
    const { auth } = await createTestAuth({ domains: ["acme.example"] });
    const res = await signIn(auth, workspaceUser);
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("portego.session_token");
  });

  test("refuses an identity from another domain and creates no account for it", async () => {
    const { auth, database } = await createTestAuth({ domains: ["acme.example"] });
    const res = await signIn(auth, {
      sub: "google-subject-2",
      email: "person@gmail.com",
      email_verified: true,
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(userCount(database)).toBe(0);
  });

  test("refuses an identity whose email the provider did not verify", async () => {
    const { auth, database } = await createTestAuth();
    const res = await signIn(auth, { ...workspaceUser, email_verified: false });
    expect(res.status).not.toBe(200);
    expect(userCount(database)).toBe(0);
  });

  test("admits a differently cased address, because domains are case-insensitive", async () => {
    const { auth } = await createTestAuth({ domains: ["acme.example"] });
    const res = await signIn(auth, { ...workspaceUser, email: "Person@Acme.Example" });
    expect(res.status).toBe(200);
  });

  test("refuses a lookalike domain that only ends with the allowed one", async () => {
    const { auth } = await createTestAuth({ domains: ["acme.example"] });
    const res = await signIn(auth, {
      ...workspaceUser,
      email: "person@notacme.example",
      hd: "notacme.example",
    });
    expect(res.status).toBe(403);
  });

  test("admits any verified identity when the deployment opts into open admission", async () => {
    const { auth } = await createTestAuth({ allowAll: true });
    const res = await signIn(auth, {
      sub: "google-subject-3",
      email: "someone@example.com",
      email_verified: true,
    });
    expect(res.status).toBe(200);
  });
});

describe("Google hosted domain", () => {
  test("refuses an id token with no hosted-domain claim", async () => {
    const { auth, database } = await createTestAuth({ hostedDomain: "acme.example" });
    const { hd: _dropped, ...withoutHostedDomain } = workspaceUser;
    const res = await signIn(auth, withoutHostedDomain);
    expect(res.status).not.toBe(200);
    expect(userCount(database)).toBe(0);
  });

  test("refuses an id token whose hosted-domain claim is another Workspace", async () => {
    const { auth, database } = await createTestAuth({ hostedDomain: "acme.example" });
    const res = await signIn(auth, { ...workspaceUser, hd: "other.example" });
    expect(res.status).not.toBe(200);
    expect(userCount(database)).toBe(0);
  });
});

describe("sessions", () => {
  test("returns the signed-in user and forgets them after sign-out", async () => {
    const { auth } = await createTestAuth();
    const signInResponse = await signIn(auth, workspaceUser);
    const cookie = signInResponse.headers.get("set-cookie") ?? "";

    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    expect(session?.user.email).toBe("person@acme.example");

    const signOut = await auth.handler(
      new Request("http://localhost:5173/api/auth/sign-out", {
        method: "POST",
        headers: { cookie, origin: "http://localhost:5173" },
      }),
    );
    expect(signOut.status).toBe(200);
    expect(await auth.api.getSession({ headers: new Headers({ cookie }) })).toBeNull();
  });

  test("stores the provider subject as the identity, not the email address", async () => {
    const { auth, database } = await createTestAuth();
    await signIn(auth, workspaceUser);
    const account = database.query("select providerId, accountId from account").get() as {
      providerId: string;
      accountId: string;
    };
    expect(account.providerId).toBe("google");
    expect(account.accountId).toBe("google-subject-1");
  });
});

describe("session cookies", () => {
  test("sets no cookie domain, so the isolated content host never receives one", async () => {
    const { auth } = await createTestAuth();
    const setCookie = (await signIn(auth, workspaceUser)).headers.get("set-cookie") ?? "";

    expect(setCookie).not.toMatch(/domain=/i);
    expect(setCookie.toLowerCase()).toContain("httponly");
    expect(setCookie.toLowerCase()).toContain("samesite=lax");
    expect(setCookie.toLowerCase()).toContain("path=/");
  });
});

describe("returning users", () => {
  test("admits the same identity again, reading the stored account", async () => {
    const { auth, database } = await createTestAuth();
    expect((await signIn(auth, workspaceUser)).status).toBe(200);
    expect((await signIn(auth, workspaceUser)).status).toBe(200);
    expect(userCount(database)).toBe(1);
  });
});
