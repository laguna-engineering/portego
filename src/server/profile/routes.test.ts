import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TEST_BASE_URL } from "../auth/testing.ts";
import { createTestServer, htmlFile, type TestServer, WORKSPACE_USER } from "../testing.ts";
import { AVATAR_MAX_BYTES, PROFILE_ACTIVITY_WINDOW_MS } from "./routes.ts";

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
