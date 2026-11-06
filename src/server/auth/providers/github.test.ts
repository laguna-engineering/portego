import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestServer, type TestServer, WORKSPACE_USER } from "../../testing.ts";
import { parseAuthConfig } from "../config.ts";
import { readGitHubSettings } from "./github.ts";

const APP = "http://localhost:5173";
const SECOND_USER = { ...WORKSPACE_USER, sub: "google-subject-2", email: "other@acme.example" };

type GitHubUser = { id: number; login: string };

/**
 * Stands in for github.com and api.github.com. Better Auth and the login lookup
 * both call the global fetch, so the token exchange and the profile reads are
 * the real code paths. An authorization code names the user it signs in as.
 */
function fakeGitHub(users: Record<string, GitHubUser>) {
  const realFetch = globalThis.fetch;
  const failing = new Set<string>();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.href === "https://github.com/login/oauth/access_token") {
      const code = new URLSearchParams(await request.text()).get("code") ?? "";
      if (!users[code]) return Response.json({ error: "bad_verification_code" });
      return Response.json({ access_token: `token-${code}`, token_type: "bearer", scope: "" });
    }
    if (url.origin === "https://api.github.com") {
      const code = (request.headers.get("authorization") ?? "").replace(/^Bearer token-/i, "");
      const user = users[code];
      if (!user) return new Response("Bad credentials", { status: 401 });
      if (url.pathname === "/user") {
        if (failing.has(code) && request.headers.get("user-agent") === "Portego") {
          return new Response("Server error", { status: 502 });
        }
        return Response.json({ ...user, name: null, email: null, avatar_url: "" });
      }
      if (url.pathname === "/user/emails") return Response.json([]);
    }
    return realFetch(input, init);
  }) as typeof fetch;
  return {
    /** Makes Portego's own login lookup fail for this code; Better Auth's read still works. */
    failLoginLookup: (code: string) => failing.add(code),
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

function cookiesFrom(response: Response): string {
  return (response.headers.get("set-cookie") ?? "")
    .split(/,(?=[^;]+=)/)
    .map((entry) => entry.split(";")[0]?.trim() ?? "")
    .filter((entry) => entry !== "")
    .join("; ");
}

/** Runs the browser flow: start the connection, then return through the callback with `code`. */
async function connect(session: string, code: string) {
  const start = await server.app.request(`${APP}/api/auth/link-social`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP, cookie: session },
    body: JSON.stringify({
      provider: "github",
      callbackURL: "/profile?github=connected",
      errorCallbackURL: "/profile?github=error",
    }),
  });
  expect(start.status).toBe(200);
  const { url } = (await start.json()) as { url: string };
  const authorization = new URL(url);
  const callback = await server.app.request(
    `${APP}/api/auth/callback/github?code=${code}&state=${encodeURIComponent(
      authorization.searchParams.get("state") ?? "",
    )}`,
    { redirect: "manual", headers: { cookie: `${session}; ${cookiesFrom(start)}` } },
  );
  return { authorization, callback };
}

async function accounts(session: string) {
  const response = await server.app.request(`${APP}/api/me/github-accounts`, {
    headers: { cookie: session },
  });
  const body = (await response.json()) as {
    accounts: { id: string; githubId: string; login: string }[];
  };
  return body.accounts;
}

let server: TestServer;
let github: ReturnType<typeof fakeGitHub>;

beforeEach(async () => {
  github = fakeGitHub({
    octo: { id: 101, login: "octocat" },
    hubot: { id: 202, login: "hubot" },
  });
  server = await createTestServer({ github: true });
});

afterEach(() => {
  server.cleanup();
  github.restore();
});

describe("settings", () => {
  test("GitHub is off unless both credentials are set", () => {
    expect(readGitHubSettings({})).toEqual({ ok: true, settings: null });
    expect(readGitHubSettings({ GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret" })).toEqual({
      ok: true,
      settings: { clientId: "id", clientSecret: "secret" },
    });
  });

  test("one credential without the other stops startup", () => {
    expect(() =>
      parseAuthConfig({ APP_NAME: "Portego", APP_URL: APP, NODE_ENV: "development" } as never, {
        AUTH_ALLOW_ALL_AUTHENTICATED: "true",
        GITHUB_CLIENT_ID: "id",
      }),
    ).toThrow("GitHub accounts are enabled but GITHUB_CLIENT_SECRET is not set");
  });

  test("the client learns whether accounts can be connected", async () => {
    const session = await server.signIn();
    const me = await server.app.request(`${APP}/api/me`, { headers: { cookie: session } });
    expect(((await me.json()) as { features: { githubAccounts: boolean } }).features).toMatchObject(
      {
        githubAccounts: true,
      },
    );

    const without = await createTestServer();
    try {
      const cookie = await without.signIn();
      const response = await without.app.request(`${APP}/api/me`, { headers: { cookie } });
      expect(
        ((await response.json()) as { features: { githubAccounts: boolean } }).features,
      ).toMatchObject({ githubAccounts: false });
    } finally {
      without.cleanup();
    }
  });
});

describe("connecting", () => {
  test("connects an account and records its id and login, without signing anybody in", async () => {
    const session = await server.signIn();
    const { authorization, callback } = await connect(session, "octo");

    // No scope: the token can read public profile data and nothing else.
    expect(authorization.origin + authorization.pathname).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(authorization.searchParams.get("scope") ?? "").toBe("");
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/profile?github=connected");
    expect(cookiesFrom(callback)).not.toContain("session_token=");

    // The numeric id is what other tools match a PR author against; the login can change.
    expect(await accounts(session)).toMatchObject([{ githubId: "101", login: "octocat" }]);
  });

  test("one person can connect several accounts", async () => {
    const session = await server.signIn();
    await connect(session, "octo");
    await connect(session, "hubot");
    expect((await accounts(session)).map((account) => account.login)).toEqual(["octocat", "hubot"]);
  });

  test("an account connected to someone else is refused, so it names one person only", async () => {
    await connect(await server.signIn(), "octo");
    const other = await server.signIn(SECOND_USER);
    const { callback } = await connect(other, "octo");

    const location = new URL(callback.headers.get("location") ?? "", APP);
    expect(location.pathname).toBe("/profile");
    expect(location.searchParams.get("github")).toBe("error");
    expect(location.searchParams.get("error")).toBe("account_already_linked_to_different_user");
    expect(await accounts(other)).toEqual([]);
  });

  test("an account whose login cannot be read is not connected", async () => {
    github.failLoginLookup("octo");
    const session = await server.signIn();
    const { callback } = await connect(session, "octo");
    expect(callback.headers.get("location")).toBe(
      "/profile?github=error&error=unable_to_link_account",
    );
    expect(await accounts(session)).toEqual([]);
  });
});

describe("what GitHub cannot do", () => {
  const post = (path: string, body: object, cookie = "") =>
    server.app.request(`${APP}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: APP, cookie },
      body: JSON.stringify(body),
    });

  test("it is not a way to sign in, even with a connected account", async () => {
    await connect(await server.signIn(), "octo");
    const response = await post("/sign-in/social", { provider: "github", callbackURL: "/" });
    expect(response.status).toBe(403);
  });

  // The linking options that let GitHub's email differ would otherwise let
  // someone attach a personal Google account and sign in with it.
  test("no other provider can be connected", async () => {
    const response = await post("/link-social", { provider: "google" }, await server.signIn());
    expect(response.status).toBe(403);
  });

  test("Better Auth's own unlink is closed, so nobody can remove the account they sign in with", async () => {
    const session = await server.signIn();
    await connect(session, "octo");
    const google = server.database
      .query("select id from account where providerId = 'google'")
      .get() as { id: string };
    const response = await post("/unlink-account", { accountId: google.id }, session);
    expect(response.status).toBe(403);
    expect(server.database.query("select count(*) as n from account").get()).toEqual({ n: 2 });
  });
});

describe("disconnecting", () => {
  const remove = (session: string, id: string) =>
    server.app.request(`${APP}/api/me/github-accounts/${id}`, {
      method: "DELETE",
      headers: { origin: APP, cookie: session },
    });

  test("removes one account and returns the others", async () => {
    const session = await server.signIn();
    await connect(session, "octo");
    await connect(session, "hubot");
    const [first] = await accounts(session);

    const response = await remove(session, first?.id ?? "");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { accounts: { login: string }[] };
    expect(body.accounts.map((account) => account.login)).toEqual(["hubot"]);
    expect((await accounts(session)).map((account) => account.login)).toEqual(["hubot"]);
  });

  test("cannot remove someone else's account, or the account a person signs in with", async () => {
    const owner = await server.signIn();
    await connect(owner, "octo");
    const [connected] = await accounts(owner);
    const other = await server.signIn(SECOND_USER);
    expect((await remove(other, connected?.id ?? "")).status).toBe(404);
    expect(await accounts(owner)).toHaveLength(1);

    const google = server.database
      .query("select id from account where providerId = 'google' and accountId = ?")
      .get(WORKSPACE_USER.sub) as { id: string };
    expect((await remove(owner, google.id)).status).toBe(404);
    expect(
      server.database.query("select count(*) as n from account where id = ?").get(google.id),
    ).toEqual({ n: 1 });
  });
});
