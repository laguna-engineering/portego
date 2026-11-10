import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TestClaims } from "../auth/testing.ts";
import { authorizeClient, callTool, registerClient } from "../mcp/testing.ts";
import {
  accessToken,
  agentKey,
  approve,
  callMcp,
  enroll,
  enrolledAgent,
} from "../service-accounts/testing.ts";
import { pageMeta } from "../social.ts";
import {
  createLiveTestServer,
  createTestServer,
  htmlFile,
  type LiveTestServer,
  type TestServer,
  WORKSPACE_USER,
} from "../testing.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

function person(sub: string, email: string, name: string): TestClaims {
  return { ...WORKSPACE_USER, sub, email, name };
}

/** In PORTEGO_ADMINS, and in no team. */
const ADMIN = WORKSPACE_USER;
/** A member in the Legal team. */
const MEMBER = person("subject-member", "member@acme.example", "Member");
/** A member in no team. */
const OUTSIDER = person("subject-outsider", "outsider@acme.example", "Outsider");
/** Invited from another domain into Legal. */
const GUEST = person("subject-guest", "guest@partner.example", "Guest");
/** Invited from another domain into Finance only. */
const STRANGER = person("subject-stranger", "stranger@partner.example", "Stranger");

type Call = { method?: string; body?: unknown };

let server: TestServer;
const cookies: Record<"admin" | "member" | "outsider" | "guest" | "stranger", string> = {
  admin: "",
  member: "",
  outsider: "",
  guest: "",
  stranger: "",
};
let ids: Record<"member" | "outsider" | "guest" | "stranger", string>;
let legal: string;
let finance: string;
/** Restricted to Legal. */
let contracts: string;
let open: string;
/** Uploaded by the member into Contracts. */
let contract: string;
/** Uploaded by the admin into Open. */
let menu: string;

function call(cookie: string, path: string, init: Call = {}) {
  return server.app.request(path, {
    method: init.method ?? "GET",
    headers: { cookie, origin: server.baseURL, "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

async function json<T>(cookie: string, path: string, init: Call = {}, status = 200): Promise<T> {
  const res = await call(cookie, path, init);
  expect(res.status, `${init.method ?? "GET"} ${path}`).toBe(status);
  return (await res.json()) as T;
}

function uploadForm(cookie: string, fields: Record<string, string>) {
  const form = new FormData();
  form.set("file", htmlFile("<p>body text</p>"));
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  return server.app.request("/api/artifacts", {
    method: "POST",
    headers: { cookie, origin: server.baseURL },
    body: form,
  });
}

async function upload(cookie: string, fields: Record<string, string>): Promise<string> {
  const res = await uploadForm(cookie, fields);
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { artifact: { id: string } }).artifact.id;
}

async function userId(cookie: string): Promise<string> {
  return (await json<{ user: { id: string } }>(cookie, "/api/me")).user.id;
}

async function createTeam(name: string): Promise<string> {
  const { team } = await json<{ team: { id: string } }>(
    cookies.admin,
    "/api/teams",
    { method: "POST", body: { name } },
    201,
  );
  return team.id;
}

async function addMember(teamId: string, member: string) {
  await json(cookies.admin, `/api/teams/${teamId}/members/${member}`, { method: "PUT" });
}

async function restrict(teamId: string, folderId: string) {
  await json(cookies.admin, `/api/teams/${teamId}/folders/${folderId}`, { method: "PUT" });
}

async function invite(email: string, teamIds: string[]) {
  return json<{ invitation: { id: string } }>(
    cookies.admin,
    "/api/invitations",
    { method: "POST", body: { email, teamIds } },
    201,
  );
}

async function createFolder(cookie: string, name: string, parentId?: string): Promise<string> {
  const { folder } = await json<{ folder: { id: string } }>(
    cookie,
    "/api/folders",
    { method: "POST", body: { name, ...(parentId ? { parentId } : {}) } },
    201,
  );
  return folder.id;
}

async function titles(cookie: string): Promise<string[]> {
  const page = await json<{ items: { title: string }[] }>(cookie, "/api/artifacts");
  return page.items.map((item) => item.title).sort();
}

async function feedTitles(cookie: string): Promise<string[]> {
  const feed = await json<{ items: { artifact: { title: string } }[] }>(
    cookie,
    "/api/activity?scope=everyone",
  );
  return feed.items.map((item) => item.artifact.title);
}

async function folderNames(cookie: string): Promise<string[]> {
  const body = await json<{ folders: { name: string }[] }>(cookie, "/api/folders");
  return body.folders.map((folder) => folder.name).sort();
}

async function setUp(
  create: () => Promise<TestServer> = () =>
    createTestServer({ teams: true, publicLinks: true, admins: [ADMIN.email ?? ""] }),
) {
  server = await create();
  cookies.admin = await server.signIn(ADMIN);
  cookies.member = await server.signIn(MEMBER);
  cookies.outsider = await server.signIn(OUTSIDER);
  legal = await createTeam("Legal");
  finance = await createTeam("Finance");
  await addMember(legal, await userId(cookies.member));
  contracts = await createFolder(cookies.admin, "Contracts");
  open = await createFolder(cookies.admin, "Open");
  await restrict(legal, contracts);
  await invite(GUEST.email ?? "", [legal]);
  await invite(STRANGER.email ?? "", [finance]);
  cookies.guest = await server.signIn(GUEST);
  cookies.stranger = await server.signIn(STRANGER);
  ids = {
    member: await userId(cookies.member),
    outsider: await userId(cookies.outsider),
    guest: await userId(cookies.guest),
    stranger: await userId(cookies.stranger),
  };
  contract = await upload(cookies.member, { title: "Contract draft", folderId: contracts });
  menu = await upload(cookies.admin, { title: "Lunch menu", folderId: open });
}

describe("with teams on", () => {
  beforeEach(() => setUp());
  afterEach(() => server.cleanup());

  // The shared loop: each path that names the artifact must hide it from
  // anyone outside its folder's team, whether a member or a guest.
  test("every artifact route answers NOT_FOUND to a member or guest outside the team", async () => {
    const attempts: [string, string, unknown?][] = [
      ["GET", `/api/artifacts/${contract}`],
      ["GET", `/api/artifacts/${contract}/versions`],
      ["GET", `/api/artifacts/${contract}/comments`],
      ["GET", `/api/artifacts/${contract}/entries`],
      ["GET", `/api/artifacts/${contract}/markdown`],
      ["GET", `/api/artifacts/${contract}/source`],
      ["GET", `/api/artifacts/${contract}/link`],
      ["POST", `/api/artifacts/${contract}/link`],
      ["DELETE", `/api/artifacts/${contract}/link`],
      ["POST", `/api/artifacts/${contract}/preview`],
      ["PATCH", `/api/artifacts/${contract}/status`, { status: "solved" }],
      ["PATCH", `/api/artifacts/${contract}/archived`, { archived: true }],
      ["PATCH", `/api/artifacts/${contract}/organization`, { tagIds: [] }],
      ["PATCH", `/api/artifacts/${contract}/visibility`, { visibility: "private" }],
      ["POST", `/api/artifacts/${contract}/comments`, { body: "hello" }],
      ["PUT", `/api/artifacts/${contract}/entries`, { key: "vote", value: 1 }],
      ["DELETE", `/api/artifacts/${contract}/entries?key=vote`],
      ["GET", `/api/activity/subscriptions/artifacts/${contract}`],
      ["PUT", `/api/activity/subscriptions/artifacts/${contract}`, { level: "all" }],
      ["POST", `/api/activity/read/artifacts/${contract}`, { versionNumber: 1 }],
    ];
    for (const who of ["outsider", "stranger", "admin"] as const) {
      for (const [method, path, body] of attempts) {
        const res = await call(cookies[who], path, { method, body });
        expect(res.status, `${who} ${method} ${path}`).toBe(404);
        const { error } = (await res.json()) as { error: { code: string } };
        expect(error.code, `${who} ${method} ${path}`).toBe("NOT_FOUND");
      }
      const version = await uploadForm(cookies[who], { title: "Mine now", artifactId: contract });
      expect(version.status, `${who} new version`).toBe(404);
    }
    const artifact = await json<{ artifact: { status: string; archivedAt: null } }>(
      cookies.member,
      `/api/artifacts/${contract}`,
    );
    expect(artifact.artifact).toMatchObject({ status: "open", archivedAt: null });
  });

  test("every reading route works for a member and a guest of the team", async () => {
    for (const who of ["member", "guest"] as const) {
      for (const path of [
        `/api/artifacts/${contract}`,
        `/api/artifacts/${contract}/versions`,
        `/api/artifacts/${contract}/comments`,
        `/api/artifacts/${contract}/entries`,
        `/api/artifacts/${contract}/markdown`,
        `/api/artifacts/${contract}/source`,
      ]) {
        expect((await call(cookies[who], path)).status, `${who} ${path}`).toBe(200);
      }
    }
  });

  test("lists, search, folders, and the activity feed leave out what the reader cannot read", async () => {
    expect(await titles(cookies.member)).toEqual(["Contract draft", "Lunch menu"]);
    expect(await titles(cookies.outsider)).toEqual(["Lunch menu"]);
    expect(await titles(cookies.admin)).toEqual(["Lunch menu"]);
    expect(await titles(cookies.guest)).toEqual(["Contract draft"]);
    expect(await titles(cookies.stranger)).toEqual([]);

    expect(await folderNames(cookies.member)).toEqual(["Contracts", "Open"]);
    expect(await folderNames(cookies.outsider)).toEqual(["Open"]);
    expect(await folderNames(cookies.guest)).toEqual(["Contracts"]);
    expect(await folderNames(cookies.stranger)).toEqual([]);

    for (const who of ["outsider", "stranger"] as const) {
      const results = await json<{ total: number; folders: { name: string }[] }>(
        cookies[who],
        "/api/artifacts/search?q=contract",
      );
      expect(results.total, who).toBe(0);
      expect(results.folders, who).toEqual([]);
      const listed = await call(cookies[who], `/api/artifacts?folderId=${contracts}`);
      expect(listed.status, who).toBe(404);
      expect(await feedTitles(cookies[who]), who).not.toContain("Contract draft");
    }
    expect(await feedTitles(cookies.guest)).toContain("Contract draft");
    const found = await json<{ total: number; folders: { name: string }[] }>(
      cookies.guest,
      "/api/artifacts/search?q=contract",
    );
    expect(found.total).toBe(1);
    expect(found.folders.map((folder) => folder.name)).toEqual(["Contracts"]);
    const unfiled = await json<{ rootArtifactCount: number }>(cookies.guest, "/api/folders");
    expect(unfiled.rootArtifactCount).toBe(0);
  });

  test("a guest sees only the tags on what they can read, and a member sees every tag", async () => {
    const tag = async (name: string, artifactId: string) => {
      const { tag } = await json<{ tag: { id: string } }>(
        cookies.member,
        "/api/tags",
        { method: "POST", body: { name } },
        201,
      );
      await json(cookies.member, `/api/artifacts/${artifactId}/organization`, {
        method: "PATCH",
        body: { tagIds: [tag.id] },
      });
      return tag.id;
    };
    await tag("nda", contract);
    const menuTag = await tag("food", menu);

    const names = async (cookie: string) =>
      (await json<{ tags: { name: string }[] }>(cookie, "/api/tags")).tags.map((t) => t.name);
    expect(await names(cookies.guest)).toEqual(["nda"]);
    expect(await names(cookies.stranger)).toEqual([]);
    expect(await names(cookies.outsider)).toEqual(["food", "nda"]);

    const hits = await json<{ tags: { name: string }[] }>(
      cookies.guest,
      "/api/artifacts/search?q=food",
    );
    expect(hits.tags).toEqual([]);
    const filtered = await call(cookies.guest, `/api/artifacts?tagId=${menuTag}`);
    expect(filtered.status).toBe(404);
  });

  test("a guest gets no one's email address, and a member does", async () => {
    await json(
      cookies.member,
      `/api/artifacts/${contract}/comments`,
      {
        method: "POST",
        body: { body: "Please review" },
      },
      201,
    );
    await json(cookies.member, `/api/artifacts/${contract}/entries`, {
      method: "PUT",
      body: { key: "vote", value: 1 },
    });

    const read = async (cookie: string) => ({
      artifact: (
        await json<{ artifact: { creator: { email: string | null } } }>(
          cookie,
          `/api/artifacts/${contract}`,
        )
      ).artifact.creator.email,
      version: (
        await json<{ versions: { creator: { email: string | null } }[] }>(
          cookie,
          `/api/artifacts/${contract}/versions`,
        )
      ).versions[0]?.creator.email,
      comment: (
        await json<{ comments: { author: { email: string | null } }[] }>(
          cookie,
          `/api/artifacts/${contract}/comments`,
        )
      ).comments[0]?.author.email,
      entry: (
        await json<{ entries: { author: { email: string | null } }[] }>(
          cookie,
          `/api/artifacts/${contract}/entries`,
        )
      ).entries[0]?.author.email,
    });
    expect(await read(cookies.guest)).toEqual({
      artifact: null,
      version: null,
      comment: null,
      entry: null,
    });
    const email = MEMBER.email;
    expect(await read(cookies.member)).toEqual({
      artifact: email,
      version: email,
      comment: email,
      entry: email,
    });
  });

  test("a guest sees the profile of someone whose work they can read, and nobody else's", async () => {
    expect((await call(cookies.guest, `/api/users/${ids.member}`)).status).toBe(200);
    expect((await call(cookies.guest, `/api/users/${ids.guest}`)).status).toBe(200);
    for (const path of [
      `/api/users/${ids.outsider}`,
      `/api/users/${ids.outsider}/avatar`,
      `/api/users/${ids.outsider}/activity`,
    ]) {
      expect((await call(cookies.guest, path)).status, path).toBe(404);
    }
    const profile = await json<{ artifactCount: number }>(
      cookies.outsider,
      `/api/users/${ids.member}`,
    );
    expect(profile.artifactCount).toBe(0);
  });

  test("following a folder needs read access to it", async () => {
    const path = `/api/activity/subscriptions/folders/${contracts}`;
    expect((await call(cookies.outsider, path)).status).toBe(404);
    expect(
      (await call(cookies.outsider, path, { method: "PUT", body: { level: "all" } })).status,
    ).toBe(404);
    expect(
      (await call(cookies.member, path, { method: "PUT", body: { level: "all" } })).status,
    ).toBe(200);
  });

  test("a team on a subfolder narrows access and never widens it", async () => {
    const both = await server.signIn(person("subject-both", "both@acme.example", "Both"));
    const fin = await server.signIn(person("subject-fin", "fin@acme.example", "Fin"));
    await addMember(legal, await userId(both));
    await addMember(finance, await userId(both));
    await addMember(finance, await userId(fin));
    const deals = await createFolder(cookies.member, "Deals", contracts);
    await restrict(finance, deals);
    await upload(both, { title: "Deal memo", folderId: deals });

    expect(await titles(both)).toContain("Deal memo");
    expect(await folderNames(both)).toContain("Deals");
    expect(await titles(cookies.member)).not.toContain("Deal memo");
    expect(await folderNames(cookies.member)).not.toContain("Deals");
    // In the subfolder's team, but not in the team above it.
    expect(await titles(fin)).not.toContain("Deal memo");
    expect(await folderNames(fin)).not.toContain("Deals");
  });

  test("a guest who can read a subfolder but not its parent sees it at the top level", async () => {
    const nested = await createFolder(cookies.member, "Nested", open);
    await restrict(legal, nested);
    const { folders } = await json<{ folders: { name: string; parentId: string | null }[] }>(
      cookies.guest,
      "/api/folders",
    );
    expect(folders.find((folder) => folder.name === "Nested")?.parentId).toBeNull();
    const member = await json<{ folders: { name: string; parentId: string | null }[] }>(
      cookies.member,
      "/api/folders",
    );
    expect(member.folders.find((folder) => folder.name === "Nested")?.parentId).toBe(open);

    const id = await upload(cookies.guest, { title: "Nested note", folderId: nested });
    const read = async (cookie: string) =>
      (
        await json<{ artifact: { folder: { parentId: string | null } } }>(
          cookie,
          `/api/artifacts/${id}`,
        )
      ).artifact.folder.parentId;
    expect(await read(cookies.guest)).toBeNull();
    expect(await read(cookies.member)).toBe(open);
  });

  test("deleting a folder that has teams is refused while it holds anything", async () => {
    const res = await call(cookies.member, `/api/folders/${contracts}`, { method: "DELETE" });
    expect(res.status).toBe(403);
    expect(await titles(cookies.member)).toContain("Contract draft");

    const empty = await createFolder(cookies.member, "Empty", open);
    await restrict(legal, empty);
    const sub = await createFolder(cookies.member, "Sub", empty);
    expect((await call(cookies.member, `/api/folders/${empty}`, { method: "DELETE" })).status).toBe(
      403,
    );
    expect((await call(cookies.member, `/api/folders/${sub}`, { method: "DELETE" })).status).toBe(
      204,
    );
    expect((await call(cookies.member, `/api/folders/${empty}`, { method: "DELETE" })).status).toBe(
      204,
    );
  });

  test("only an admin can move a folder into or out of a team's folder", async () => {
    const a = await createFolder(cookies.member, "A", contracts);
    const b = await createFolder(cookies.member, "B", contracts);
    const outOf = await call(cookies.member, `/api/folders/${b}`, {
      method: "PATCH",
      body: { parentId: open },
    });
    expect(outOf.status).toBe(403);
    const into = await call(cookies.outsider, `/api/folders/${open}`, {
      method: "PATCH",
      body: { parentId: contracts },
    });
    expect(into.status).toBe(404);

    // Moves that keep the same teams on the path need no admin. A folder's
    // own teams move with it.
    await json(cookies.member, `/api/folders/${b}`, { method: "PATCH", body: { parentId: a } });
    await json(cookies.member, `/api/folders/${contracts}`, {
      method: "PATCH",
      body: { parentId: open },
    });
    expect(await titles(cookies.outsider)).not.toContain("Contract draft");
  });

  test("an admin's move under a team's folder revokes the public links below it", async () => {
    const { url } = await json<{ url: string }>(cookies.member, `/api/artifacts/${contract}/link`, {
      method: "POST",
    });
    const token = url.split("/").pop() ?? "";
    expect((await call("", `/api/shared/${token}`)).status).toBe(200);

    // Admins do not bypass teams: the admin joins both before moving.
    const adminId = await userId(cookies.admin);
    await addMember(legal, adminId);
    await addMember(finance, adminId);
    const vault = await createFolder(cookies.admin, "Vault");
    await restrict(finance, vault);
    await json(cookies.admin, `/api/folders/${contracts}`, {
      method: "PATCH",
      body: { parentId: vault },
    });

    expect((await call("", `/api/shared/${token}`)).status).toBe(404);
    const revoked = server.database
      .query(
        "select change, actorId from artifactLinkChanges where artifactId = ? order by createdAt, change",
      )
      .all(contract);
    expect(revoked).toEqual([
      { change: "created", actorId: ids.member },
      { change: "revoked", actorId: adminId },
    ]);
    // In Legal but not Finance, so Contracts is now out of reach.
    expect(await titles(cookies.member)).not.toContain("Contract draft");
  });

  test("a guest cannot change what has teams, create at the top level, or touch tags", async () => {
    expect(
      (await call(cookies.guest, "/api/folders", { method: "POST", body: { name: "Mine" } }))
        .status,
    ).toBe(403);
    const inside = await call(cookies.guest, "/api/folders", {
      method: "POST",
      body: { name: "Mine", parentId: contracts },
    });
    expect(inside.status).toBe(201);
    for (const [method, body] of [
      ["PATCH", { name: "Renamed" }],
      ["PATCH", { parentId: null }],
      ["DELETE", undefined],
    ] as const) {
      const res = await call(cookies.guest, `/api/folders/${contracts}`, { method, body });
      expect(res.status, `${method} ${JSON.stringify(body)}`).toBe(403);
    }
    expect(
      (await call(cookies.guest, "/api/tags", { method: "POST", body: { name: "x" } })).status,
    ).toBe(403);
    expect(await folderNames(cookies.member)).toEqual(["Contracts", "Mine", "Open"]);
  });

  test("filing an artifact needs read access to the folder, and a guest cannot unfile one", async () => {
    const res = await call(cookies.outsider, `/api/artifacts/${menu}/organization`, {
      method: "PATCH",
      body: { folderId: contracts },
    });
    expect(res.status).toBe(404);
    const unfile = await call(cookies.guest, `/api/artifacts/${contract}/organization`, {
      method: "PATCH",
      body: { folderId: null },
    });
    expect(unfile.status).toBe(403);
    expect(await titles(cookies.guest)).toEqual(["Contract draft"]);
  });

  test("a guest must upload into a folder they can read", async () => {
    const unfiled = await uploadForm(cookies.guest, { title: "Loose" });
    expect(unfiled.status).toBe(400);
    const elsewhere = await uploadForm(cookies.guest, { title: "Loose", folderId: open });
    expect(elsewhere.status).toBe(404);
    await upload(cookies.guest, { title: "Signed copy", folderId: contracts });
    expect(await titles(cookies.member)).toContain("Signed copy");
    expect(await titles(cookies.outsider)).not.toContain("Signed copy");
    expect(await titles(cookies.outsider)).not.toContain("Loose");

    const outsider = await uploadForm(cookies.outsider, { title: "Sneak", folderId: contracts });
    expect(outsider.status).toBe(404);
  });

  test("team members make and revoke public links, and guests cannot", async () => {
    const refused = await call(cookies.guest, `/api/artifacts/${contract}/link`, {
      method: "POST",
    });
    expect(refused.status).toBe(403);
    const { url } = await json<{ url: string }>(cookies.member, `/api/artifacts/${contract}/link`, {
      method: "POST",
    });
    const token = url.split("/").pop() ?? "";
    // A public link works in every folder.
    expect((await call("", `/api/shared/${token}`)).status).toBe(200);
    const revoke = await call(cookies.guest, `/api/artifacts/${contract}/link`, {
      method: "DELETE",
    });
    expect(revoke.status).toBe(403);
    expect((await call("", `/api/shared/${token}`)).status).toBe(200);
  });

  test("a public link previews an artifact in a team's folder", async () => {
    const { url } = await json<{ url: string }>(cookies.member, `/api/artifacts/${contract}/link`, {
      method: "POST",
    });
    const shared = await json<{ preview: { url: string } }>(
      "",
      `/api/shared/${url.split("/").pop()}`,
    );
    expect((await server.app.request(shared.preview.url)).status).toBe(200);
  });

  // Chat apps unfurl a link without a session.
  test("a page's social preview names only what a signed-out reader could read", async () => {
    const deps = { auth: server.auth, artifacts: server.artifacts };
    expect(await pageMeta(`/a/${contract}`, new Headers(), deps)).toBeNull();
    expect(await pageMeta(`/a/${menu}`, new Headers(), deps)).toMatchObject({
      title: "Lunch menu",
    });
  });

  test("a folder's first team revokes the links below it, and a second team revokes none", async () => {
    const team = await createFolder(cookies.admin, "Team space", open);
    const inner = await createFolder(cookies.admin, "Inner", team);
    const a = await upload(cookies.admin, { title: "A", folderId: inner });
    const link = async (id: string) =>
      (
        await json<{ url: string }>(cookies.admin, `/api/artifacts/${id}/link`, {
          method: "POST",
        })
      ).url
        .split("/")
        .pop() ?? "";
    const first = await link(a);
    const adminId = await userId(cookies.admin);
    await addMember(legal, adminId);
    await restrict(legal, team);
    expect((await call("", `/api/shared/${first}`)).status).toBe(404);

    const second = await link(a);
    await restrict(finance, team);
    expect((await call("", `/api/shared/${second}`)).status).toBe(200);
  });

  test("a team that restricts a folder cannot be deleted", async () => {
    expect((await call(cookies.admin, `/api/teams/${legal}`, { method: "DELETE" })).status).toBe(
      403,
    );
    await json(cookies.admin, `/api/teams/${legal}/folders/${contracts}`, { method: "DELETE" });
    expect((await call(cookies.admin, `/api/teams/${legal}`, { method: "DELETE" })).status).toBe(
      204,
    );
    // With no team left on it, the folder is open to every member again.
    expect(await titles(cookies.outsider)).toContain("Contract draft");
  });

  test("only admins reach the team and invitation routes", async () => {
    for (const path of ["/api/teams", "/api/invitations"]) {
      expect((await call(cookies.member, path)).status, path).toBe(403);
      expect((await call(cookies.admin, path)).status, path).toBe(200);
    }
  });

  test("/api/me names the feature and whether the user is a guest", async () => {
    const me = async (cookie: string) =>
      json<{ user: { guest: boolean }; features: { teams?: boolean } }>(cookie, "/api/me");
    expect(await me(cookies.guest)).toMatchObject({
      user: { guest: true },
      features: { teams: true },
    });
    expect(await me(cookies.member)).toMatchObject({
      user: { guest: false },
      features: { teams: true },
    });
  });
});

describe("admission with teams on", () => {
  beforeEach(() => setUp());
  afterEach(() => server.cleanup());

  test("an address from another domain signs in only with an open invitation", async () => {
    const uninvited = person("subject-uninvited", "nobody@partner.example", "Nobody");
    await expect(server.signIn(uninvited)).rejects.toThrow();

    const { invitation } = await invite("revoked@partner.example", [legal]);
    expect(
      (await call(cookies.admin, `/api/invitations/${invitation.id}`, { method: "DELETE" })).status,
    ).toBe(204);
    await expect(
      server.signIn(person("subject-revoked", "revoked@partner.example", "Revoked")),
    ).rejects.toThrow();
  });

  test("a guest signs in again after the invitation was used", async () => {
    const again = await server.signIn(GUEST);
    expect(await titles(again)).toEqual(["Contract draft"]);
  });

  test("an invited member stays a member and gains the invitation's teams", async () => {
    await invite(OUTSIDER.email ?? "", [legal]);
    const again = await server.signIn(OUTSIDER);
    expect(await titles(again)).toEqual(["Contract draft", "Lunch menu"]);
    expect(await json(again, "/api/me")).toMatchObject({ user: { guest: false } });
  });

  test("a service account's address cannot be invited", async () => {
    const res = await call(cookies.admin, "/api/invitations", {
      method: "POST",
      body: { email: "agent@service.invalid", teamIds: [legal] },
    });
    expect(res.status).toBe(400);
  });
});

describe("an invitation", () => {
  afterEach(() => server.cleanup());

  test("expires after 7 days", async () => {
    let now = Date.now() - 8 * DAY_MS;
    server = await createTestServer({
      teams: true,
      admins: [ADMIN.email ?? ""],
      now: () => now,
    });
    cookies.admin = await server.signIn(ADMIN);
    const team = await createTeam("Late");
    await invite(GUEST.email ?? "", [team]);
    now = Date.now();
    await expect(server.signIn(GUEST)).rejects.toThrow();
  });
});

describe("with teams off", () => {
  afterEach(() => server.cleanup());

  test("the team and invitation routes do not exist, and nobody is a guest", async () => {
    server = await createTestServer({ admins: [ADMIN.email ?? ""] });
    cookies.admin = await server.signIn(ADMIN);
    for (const path of ["/api/teams", "/api/invitations"]) {
      expect((await call(cookies.admin, path)).status, path).toBe(404);
      expect((await call(cookies.admin, path, { method: "POST", body: {} })).status, path).toBe(
        404,
      );
    }
    const me = await json<{ user: Record<string, unknown>; features: Record<string, unknown> }>(
      cookies.admin,
      "/api/me",
    );
    expect(me.user.guest).toBeUndefined();
    expect(me.features.teams).toBeUndefined();
  });
});

async function readUntil(res: Response, wanted: RegExp, timeoutMs = 2000): Promise<string> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let seen = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const next = await Promise.race([
        reader.read(),
        Bun.sleep(deadline - Date.now()).then(() => "timeout" as const),
      ]);
      if (next === "timeout" || (typeof next === "object" && next.done)) break;
      if (typeof next === "object" && next.value) seen += decoder.decode(next.value);
      if (wanted.test(seen)) return seen;
    }
  } finally {
    await reader.cancel();
  }
  throw new Error(`Stream never matched ${wanted}. Saw: ${JSON.stringify(seen)}`);
}

// Each test publishes a marker every stream receives after the change, and
// reads up to it, so a stream cannot pass by being read too early.
describe("the change stream with teams on", () => {
  beforeEach(() => setUp());
  afterEach(() => server.cleanup());

  const stream = (cookie: string) => server.app.request("/api/events", { headers: { cookie } });

  async function heard(
    who: (keyof typeof cookies)[],
    change: () => Promise<string>,
  ): Promise<Record<string, boolean>> {
    const streams = await Promise.all(who.map((name) => stream(cookies[name])));
    const id = await change();
    server.events.publish({ type: "tag.changed", id: "marker" });
    const result: Record<string, boolean> = {};
    for (const [index, name] of who.entries()) {
      const stream = streams[index] as Response;
      result[name] = (await readUntil(stream, /marker/)).includes(id);
    }
    return result;
  }

  test("an upload into a team's folder reaches the team and nobody else", async () => {
    expect(
      await heard(["member", "guest", "outsider", "stranger"], () =>
        upload(cookies.member, { title: "New", folderId: contracts }),
      ),
    ).toEqual({ member: true, guest: true, outsider: false, stranger: false });
  });

  test("a change to a team's folder reaches only those who read it", async () => {
    expect(
      await heard(["member", "guest", "outsider"], async () => {
        await json(cookies.member, `/api/folders/${contracts}`, {
          method: "PATCH",
          body: { name: "Agreements" },
        });
        return contracts;
      }),
    ).toEqual({ member: true, guest: true, outsider: false });
  });

  // Their pages hide the folder on hearing the change.
  test("restricting a folder reaches those who could read it until then", async () => {
    expect(
      await heard(["outsider", "guest"], async () => {
        await restrict(legal, open);
        return open;
      }),
    ).toEqual({ outsider: true, guest: true });
  });

  test("deleting a team's folder reaches its team and nobody else", async () => {
    const empty = await createFolder(cookies.member, "Empty", contracts);
    expect(
      await heard(["member", "outsider"], async () => {
        expect(
          (await call(cookies.member, `/api/folders/${empty}`, { method: "DELETE" })).status,
        ).toBe(204);
        return empty;
      }),
    ).toEqual({ member: true, outsider: false });
  });

  test("making a team's artifact private reaches the team and nobody outside it", async () => {
    expect(
      await heard(["guest", "outsider"], async () => {
        await json(cookies.member, `/api/artifacts/${contract}/visibility`, {
          method: "PATCH",
          body: { visibility: "private" },
        });
        return contract;
      }),
    ).toEqual({ guest: true, outsider: false });
  });

  test("moving an artifact into a team's folder reaches those who could read it before", async () => {
    expect(
      await heard(["outsider", "stranger"], async () => {
        await json(
          cookies.admin,
          `/api/artifacts/${menu}/organization`,
          {
            method: "PATCH",
            body: { folderId: contracts },
          },
          404,
        );
        await json(cookies.member, `/api/artifacts/${menu}/organization`, {
          method: "PATCH",
          body: { folderId: contracts },
        });
        return menu;
      }),
    ).toEqual({ outsider: true, stranger: false });
    expect(await titles(cookies.outsider)).toEqual([]);
  });
});

describe("agents with teams on", () => {
  let live: LiveTestServer;

  beforeEach(async () => {
    await setUp(async () => {
      live = await createLiveTestServer({
        teams: true,
        serviceAccounts: true,
        admins: [ADMIN.email ?? ""],
      });
      return live;
    });
  });
  afterEach(() => live.stop());

  // A guest's token passes admission on every request through the guests row,
  // since the invitation is used up.
  test("a guest's MCP client reads the team's folder and nobody's email", async () => {
    const client = await authorizeClient(live, {
      cookie: cookies.guest,
      clientId: await registerClient(live, cookies.guest),
    });
    const metadata = await callTool(client, "get_artifact_metadata", { id: contract });
    expect(metadata.result?.structuredContent).toMatchObject({
      title: "Contract draft",
      creator: { email: null },
    });
    const hidden = await callTool(client, "get_artifact_metadata", { id: menu });
    expect(hidden.result?.isError).toBe(true);
    const folders = await callTool(client, "list_folders");
    const listed = folders.result?.structuredContent as { folders: { name: string }[] } | undefined;
    expect(listed?.folders.map((folder) => folder.name)).toEqual(["Contracts"]);
  });

  test("an outsider's MCP client cannot read the team's artifact", async () => {
    const client = await authorizeClient(live, {
      cookie: cookies.outsider,
      clientId: await registerClient(live, cookies.outsider),
    });
    const result = await callTool(client, "get_artifact_metadata", { id: contract });
    expect(result.result?.isError).toBe(true);
  });

  test("a service account approved as a guest reads only its teams' folders", async () => {
    const agent = await enrolledAgent(live, cookies.admin, { guest: true, teamIds: [legal] });
    const token = await accessToken(live, agent);
    const res = await callMcp(live, token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_artifacts", arguments: {} },
    });
    const body = (await res.json()) as {
      result: { structuredContent: { items: { title: string }[] } };
    };
    expect(body.result.structuredContent.items.map((item) => item.title)).toEqual([
      "Contract draft",
    ]);
    const { accounts } = await json<{ accounts: { id: string; guest: boolean }[] }>(
      cookies.admin,
      "/api/service-accounts",
    );
    expect(accounts.find((account) => account.id === agent.userId)?.guest).toBe(true);
  });

  test("a guest service account needs one or more existing teams", async () => {
    const key = await agentKey();
    const { id } = (await (await enroll(live, key)).json()) as { id: string };
    for (const approval of [{ guest: true }, { guest: true, teamIds: ["no-such-team"] }]) {
      expect((await approve(live, cookies.admin, id, approval)).status).toBe(400);
    }
  });
});

describe("a service account with teams off", () => {
  test("cannot be approved as a guest", async () => {
    const live = await createLiveTestServer({
      serviceAccounts: true,
      admins: [ADMIN.email ?? ""],
    });
    try {
      const admin = await live.signIn(ADMIN);
      const key = await agentKey();
      const { id } = (await (await enroll(live, key)).json()) as { id: string };
      const res = await approve(live, admin, id, { guest: true, teamIds: ["any"] });
      expect(res.status).toBe(400);
    } finally {
      live.stop();
    }
  });
});

describe("the Varda outbox with teams on", () => {
  afterEach(() => server.cleanup());

  test("records a change only when Varda's account is in the folder's team", async () => {
    server = await createTestServer({ teams: true, varda: {}, admins: [ADMIN.email ?? ""] });
    cookies.admin = await server.signIn(ADMIN);
    cookies.member = await server.signIn(MEMBER);
    const team = await createTeam("Review");
    await addMember(team, await userId(cookies.member));
    const folder = await createFolder(cookies.admin, "Reviews");
    await restrict(team, folder);
    const schema = { keys: { "status:{item}": { value: { enum: ["confirmed"] }, varda: true } } };
    const form = new FormData();
    form.set(
      "file",
      new File(
        [
          `<!doctype html><html><head><title>Review</title><script type="application/json" id="portego-entries">${JSON.stringify(schema)}</script></head><body><p>x</p></body></html>`,
        ],
        "review.html",
        { type: "text/html" },
      ),
    );
    form.set("title", "Review");
    form.set("folderId", folder);
    const uploaded = await server.app.request("/api/artifacts", {
      method: "POST",
      headers: { cookie: cookies.member, origin: server.baseURL },
      body: form,
    });
    const { artifact } = (await uploaded.json()) as { artifact: { id: string } };
    const set = (value: string) =>
      json(cookies.member, `/api/artifacts/${artifact.id}/entries`, {
        method: "PUT",
        body: { key: "status:I-1", value },
      });

    await set("confirmed");
    expect(server.vardaOutbox.backlog()).toEqual([]);

    await addMember(team, server.vardaAccount ?? "");
    const cleared = await call(
      cookies.member,
      `/api/artifacts/${artifact.id}/entries?key=status:I-1`,
      {
        method: "DELETE",
      },
    );
    expect(cleared.status).toBe(204);
    expect(server.vardaOutbox.backlog().map((row) => JSON.parse(row.data).change)).toEqual([
      "clear",
    ]);
  });
});
