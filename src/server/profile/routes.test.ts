import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TEST_BASE_URL } from "../auth/testing.ts";
import { createTestServer, htmlFile, type TestServer, WORKSPACE_USER } from "../testing.ts";
import { AVATAR_MAX_BYTES, DISPLAY_NAME_MAX_LENGTH, PROFILE_ACTIVITY_WINDOW_MS } from "./routes.ts";

let server: TestServer;
let cookie: string;
let other: string;

beforeEach(async () => {
  server = await createTestServer();
  cookie = await server.signIn();
  other = await server.signIn({
    ...WORKSPACE_USER,
    sub: "google-subject-2",
    email: "other@acme.example",
    name: "B Person",
  });
});

afterEach(() => {
  server.cleanup();
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function putAvatar(body: Uint8Array<ArrayBuffer> | string, sessionCookie = cookie) {
  return server.app.request("/api/me/avatar", {
    method: "PUT",
    headers: { cookie: sessionCookie, origin: TEST_BASE_URL, "content-type": "image/png" },
    body,
  });
}

async function me(sessionCookie = cookie): Promise<{ user: { avatar: string | null } }> {
  const res = await server.app.request("/api/me", { headers: { cookie: sessionCookie } });
  expect(res.status).toBe(200);
  return (await res.json()) as { user: { avatar: string | null } };
}

describe("avatar", () => {
  test("is stored for the uploader alone and served with the type read from its bytes", async () => {
    expect((await me()).user.avatar).toBeNull();

    const res = await putAvatar(PNG);
    expect(res.status).toBe(200);
    const { avatar } = (await res.json()) as { avatar: string };
    expect(avatar).toStartWith("/api/me/avatar?v=");
    expect((await me()).user.avatar).toBe(avatar);

    const served = await server.app.request(avatar, { headers: { cookie } });
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);

    // Someone else's session never reaches it.
    expect((await me(other)).user.avatar).toBeNull();
    const theirs = await server.app.request("/api/me/avatar", { headers: { cookie: other } });
    expect(theirs.status).toBe(404);
  });

  test("refuses a file that is not an image, whatever it claims to be", async () => {
    // SVG is a document that can carry script, and this one would run on the app's origin.
    const res = await putAvatar('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "UNSUPPORTED_CONTENT",
    );
    expect((await me()).user.avatar).toBeNull();
  });

  test("refuses an image over the limit and keeps the one already there", async () => {
    await putAvatar(PNG);
    const before = (await me()).user.avatar;

    const big = new Uint8Array(AVATAR_MAX_BYTES + 1);
    big.set(PNG);
    const res = await putAvatar(big);
    expect(res.status).toBe(413);
    expect((await me()).user.avatar).toBe(before);
  });

  test("can be removed", async () => {
    await putAvatar(PNG);
    const res = await server.app.request("/api/me/avatar", {
      method: "DELETE",
      headers: { cookie, origin: TEST_BASE_URL },
    });
    expect(res.status).toBe(200);
    expect((await me()).user.avatar).toBeNull();
  });

  test("needs a session", async () => {
    expect((await server.app.request("/api/me/avatar")).status).toBe(401);
    expect((await server.app.request("/api/me/activity")).status).toBe(401);
  });
});

describe("activity", () => {
  async function upload(sessionCookie: string, title: string, artifactId?: string) {
    const form = new FormData();
    form.set("file", htmlFile("<p>x</p>"));
    form.set("title", title);
    if (artifactId) form.set("artifactId", artifactId);
    const res = await server.app.request("/api/artifacts", {
      method: "POST",
      headers: { cookie: sessionCookie, origin: TEST_BASE_URL },
      body: form,
    });
    expect(res.status).toBeLessThan(300);
    return ((await res.json()) as { artifact: { id: string } }).artifact.id;
  }

  async function comment(sessionCookie: string, artifactId: string) {
    const res = await server.app.request(`/api/artifacts/${artifactId}/comments`, {
      method: "POST",
      headers: {
        cookie: sessionCookie,
        origin: TEST_BASE_URL,
        "content-type": "application/json",
      },
      body: JSON.stringify({ body: "Looks good" }),
    });
    expect(res.status).toBe(201);
  }

  async function activity() {
    const res = await server.app.request("/api/me/activity", { headers: { cookie } });
    expect(res.status).toBe(200);
    return (await res.json()) as { uploads: number[]; versions: number[]; comments: number[] };
  }

  test("counts the user's own uploads, new versions, and comments, and nobody else's", async () => {
    const id = await upload(cookie, "Mine");
    await upload(cookie, "Mine", id);
    await comment(cookie, id);
    await comment(cookie, id);

    // On the user's own artifact, so only who did it decides.
    await upload(other, "Mine", id);
    await comment(other, id);
    await upload(other, "Theirs");

    const result = await activity();
    expect(result.uploads).toHaveLength(1);
    expect(result.versions).toHaveLength(1);
    expect(result.comments).toHaveLength(2);
  });

  test("leaves out what happened before the graph's window", async () => {
    const id = await upload(cookie, "Old");
    await comment(cookie, id);
    const old = Date.now() - PROFILE_ACTIVITY_WINDOW_MS - 24 * 60 * 60 * 1000;
    server.database.query("update artifactVersions set createdAt = ?").run(old);
    server.database.query("update artifactComments set createdAt = ?").run(old);

    expect(await activity()).toEqual({ uploads: [], versions: [], comments: [] });
  });
});

describe("member profiles", () => {
  async function userId(sessionCookie: string) {
    const res = await server.app.request("/api/me", { headers: { cookie: sessionCookie } });
    return ((await res.json()) as { user: { id: string } }).user.id;
  }

  async function upload(
    sessionCookie: string,
    title: string,
    options: { artifactId?: string; visibility?: string } = {},
  ) {
    const form = new FormData();
    form.set("file", htmlFile("<p>x</p>", `${title.toLowerCase()}.html`));
    form.set("title", title);
    if (options.artifactId) form.set("artifactId", options.artifactId);
    if (options.visibility) form.set("visibility", options.visibility);
    const res = await server.app.request("/api/artifacts", {
      method: "POST",
      headers: { cookie: sessionCookie, origin: TEST_BASE_URL },
      body: form,
    });
    expect(res.status).toBeLessThan(300);
    return ((await res.json()) as { artifact: { id: string } }).artifact.id;
  }

  async function comment(sessionCookie: string, artifactId: string) {
    const res = await server.app.request(`/api/artifacts/${artifactId}/comments`, {
      method: "POST",
      headers: { cookie: sessionCookie, origin: TEST_BASE_URL, "content-type": "application/json" },
      body: JSON.stringify({ body: "Looks good" }),
    });
    expect(res.status).toBe(201);
  }

  type History = {
    entries: {
      kind: string;
      versionNumber: number | null;
      artifact: { id: string; title: string; filename: string };
    }[];
    total: number;
    pageSize: number;
  };

  async function history(id: string, search = "", sessionCookie = other): Promise<History> {
    const res = await server.app.request(`/api/users/${id}/activity${search}`, {
      headers: { cookie: sessionCookie },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as History;
  }

  test("names the member and counts the artifacts they worked on, without their email", async () => {
    const id = await userId(cookie);
    const mine = await upload(cookie, "Mine");
    await comment(cookie, mine);
    await comment(cookie, await upload(other, "Theirs"));

    const res = await server.app.request(`/api/users/${id}`, { headers: { cookie: other } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      user: Record<string, unknown> & { joinedAt: number };
      artifactCount: number;
    };
    expect(body.user.name).toBe(WORKSPACE_USER.name as string);
    expect(body.user.email).toBeUndefined();
    expect(body.user.joinedAt).toBeGreaterThan(0);
    expect(body.artifactCount).toBe(2);
  });

  test("lists what the member did, newest first, labelled created, updated, or commented", async () => {
    const id = await userId(cookie);
    const artifact = await upload(cookie, "Chart");
    await upload(cookie, "Chart", { artifactId: artifact });
    await comment(cookie, artifact);
    // Someone else's work on the member's artifact is not the member's activity.
    await comment(other, artifact);

    const { entries, total } = await history(id);
    expect(total).toBe(3);
    expect(entries.map((entry) => [entry.kind, entry.versionNumber])).toEqual([
      ["commented", null],
      ["updated", 2],
      ["created", null],
    ]);
    expect(entries[0]?.artifact).toEqual({ id: artifact, title: "Chart", filename: "chart.html" });
  });

  test("hides activity on artifacts the viewer cannot open", async () => {
    const id = await userId(cookie);
    const secret = await upload(cookie, "Secret", { visibility: "private" });
    await comment(cookie, secret);
    await upload(cookie, "Shared");

    // A private title would leak through the profile otherwise.
    const seen = await history(id);
    expect(seen.entries.map((entry) => entry.artifact.title)).toEqual(["Shared"]);
    const profile = await server.app.request(`/api/users/${id}`, { headers: { cookie: other } });
    expect(((await profile.json()) as { artifactCount: number }).artifactCount).toBe(1);

    // The member still sees all of it on their own profile.
    expect((await history(id, "", cookie)).total).toBe(3);
  });

  test("filters by kind and pages through the rest, counting every match", async () => {
    const id = await userId(cookie);
    const artifact = await upload(cookie, "Busy");
    for (let i = 0; i < 12; i++) await comment(cookie, artifact);

    const first = await history(id, "?kind=commented");
    expect(first.total).toBe(12);
    expect(first.entries).toHaveLength(first.pageSize);
    const second = await history(id, "?kind=commented&page=1");
    expect(second.entries).toHaveLength(12 - first.pageSize);
    expect(second.entries.every((entry) => entry.kind === "commented")).toBe(true);

    expect((await history(id, "?kind=created")).total).toBe(1);
    // A kind it does not define falls back to everything.
    expect((await history(id, "?kind=nonsense")).total).toBe(13);
  });

  test("serves the member's avatar to other members", async () => {
    await putAvatar(PNG);
    const id = await userId(cookie);
    const res = await server.app.request(`/api/users/${id}`, { headers: { cookie: other } });
    const { avatar } = ((await res.json()) as { user: { avatar: string } }).user;
    expect(avatar).toStartWith(`/api/users/${id}/avatar?v=`);

    const served = await server.app.request(avatar, { headers: { cookie: other } });
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("content-security-policy")).toContain("sandbox");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);
  });

  test("answers 404 for someone who is not a member, and 401 without a session", async () => {
    const missing = await server.app.request("/api/users/nobody", { headers: { cookie } });
    expect(missing.status).toBe(404);
    const id = await userId(cookie);
    expect((await server.app.request(`/api/users/${id}`)).status).toBe(401);
    expect((await server.app.request(`/api/users/${id}/activity`)).status).toBe(401);
    expect((await server.app.request(`/api/users/${id}/avatar`)).status).toBe(401);
  });
});

describe("display name", () => {
  function putName(displayName: unknown, sessionCookie = cookie) {
    return server.app.request("/api/me/display-name", {
      method: "PUT",
      headers: { cookie: sessionCookie, origin: TEST_BASE_URL, "content-type": "application/json" },
      body: JSON.stringify({ displayName }),
    });
  }

  async function names(sessionCookie = cookie) {
    const res = await server.app.request("/api/me", { headers: { cookie: sessionCookie } });
    return (
      (await res.json()) as {
        user: { id: string; name: string; displayName: string | null; defaultName: string };
      }
    ).user;
  }

  test("starts from the name sign-in recorded, and a chosen name replaces it until reset", async () => {
    const before = await names();
    expect(before).toMatchObject({
      name: WORKSPACE_USER.name as string,
      displayName: null,
      defaultName: WORKSPACE_USER.name as string,
    });

    const res = await putName("  Ada   Lovelace ");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: "Ada Lovelace",
      displayName: "Ada Lovelace",
      defaultName: WORKSPACE_USER.name as string,
    });
    expect(await names()).toMatchObject({ name: "Ada Lovelace", displayName: "Ada Lovelace" });
    // Only the user who chose it is renamed.
    expect((await names(other)).name).toBe("B Person");

    // An empty name and null both go back to the recorded one.
    await putName("   ");
    expect(await names()).toMatchObject({ name: WORKSPACE_USER.name as string, displayName: null });
    await putName("Ada");
    await putName(null);
    expect((await names()).displayName).toBeNull();
  });

  test("is the name others see on artifacts, comments, activity, and the profile", async () => {
    await putName("Ada");
    const form = new FormData();
    form.set("file", htmlFile("<p>x</p>"));
    form.set("title", "Named");
    const uploaded = await server.app.request("/api/artifacts", {
      method: "POST",
      headers: { cookie, origin: TEST_BASE_URL },
      body: form,
    });
    const { artifact } = (await uploaded.json()) as { artifact: { id: string } };
    await server.app.request(`/api/artifacts/${artifact.id}/comments`, {
      method: "POST",
      headers: { cookie, origin: TEST_BASE_URL, "content-type": "application/json" },
      body: JSON.stringify({ body: "Hello" }),
    });

    const get = async (path: string) =>
      (await server.app.request(path, { headers: { cookie: other } })).json() as Promise<
        Record<string, unknown>
      >;
    const seen = (await get(`/api/artifacts/${artifact.id}`)) as {
      artifact: { creator: { name: string } };
    };
    expect(seen.artifact.creator.name).toBe("Ada");
    const comments = (await get(`/api/artifacts/${artifact.id}/comments`)) as {
      comments: { author: { name: string } }[];
    };
    expect(comments.comments[0]?.author.name).toBe("Ada");
    const versions = (await get(`/api/artifacts/${artifact.id}/versions`)) as {
      versions: { creator: { name: string } }[];
    };
    expect(versions.versions[0]?.creator.name).toBe("Ada");
    const activity = (await get("/api/activity")) as { items: { actor: { name: string } }[] };
    expect(activity.items.map((item) => item.actor.name)).toEqual(["Ada", "Ada"]);
    const profile = (await get(`/api/users/${(await names()).id}`)) as { user: { name: string } };
    expect(profile.user.name).toBe("Ada");
  });

  test("refuses a name that is too long, not text, or holds control characters", async () => {
    await putName("Ada");
    for (const bad of ["x".repeat(DISPLAY_NAME_MAX_LENGTH + 1), 42, "Ada\u0000", "Ada\u001b[31m"]) {
      const res = await putName(bad);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("INVALID_INPUT");
    }
    // A refused name leaves the one already there.
    expect((await names()).displayName).toBe("Ada");
    // The limit counts characters, not UTF-16 units.
    expect((await putName("😀".repeat(DISPLAY_NAME_MAX_LENGTH))).status).toBe(200);
  });

  test("needs a session", async () => {
    const res = await server.app.request("/api/me/display-name", {
      method: "PUT",
      headers: { origin: TEST_BASE_URL, "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Ada" }),
    });
    expect(res.status).toBe(401);
  });
});
