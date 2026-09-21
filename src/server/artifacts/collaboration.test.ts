import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TEST_BASE_URL } from "../auth/testing.ts";
import { createTestServer, htmlFile, type TestServer } from "../testing.ts";

let server: TestServer;
let cookie: string;

beforeEach(async () => {
  server = await createTestServer();
  cookie = await server.signIn();
});

afterEach(() => {
  server.cleanup();
});

const write = { cookie: "", origin: TEST_BASE_URL, "content-type": "application/json" };

function headers(sessionCookie = cookie) {
  return { ...write, cookie: sessionCookie };
}

const ANCHOR = { quote: "the important part", prefix: "before ", suffix: " after" };

async function upload(title: string): Promise<string> {
  const form = new FormData();
  form.set("file", htmlFile("<p>x</p>"));
  form.set("title", title);
  const res = await server.app.request("/api/artifacts", {
    method: "POST",
    headers: { cookie, origin: TEST_BASE_URL },
    body: form,
  });
  const body = (await res.json()) as { artifact: { id: string } };
  return body.artifact.id;
}

async function listed(query = ""): Promise<{ title: string; status: string }[]> {
  const res = await server.app.request(`/api/artifacts${query}`, { headers: { cookie } });
  const body = (await res.json()) as { items: { title: string; status: string }[] };
  return body.items;
}

describe("status", () => {
  test("starts open and records who solved it", async () => {
    const id = await upload("A question");
    expect((await listed())[0]?.status).toBe("open");

    const res = await server.app.request(`/api/artifacts/${id}/status`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ status: "solved" }),
    });
    expect(res.status).toBe(200);

    const session = await server.auth.api.getSession({ headers: new Headers({ cookie }) });
    const row = server.database
      .query("select status, statusChangedBy, statusChangedAt from artifacts where id = ?")
      .get(id) as { status: string; statusChangedBy: string; statusChangedAt: number };
    expect(row.status).toBe("solved");
    expect(row.statusChangedBy).toBe(session?.user.id ?? "");
    expect(row.statusChangedAt).toBeGreaterThan(0);
  });

  test("can be moved back to open", async () => {
    const id = await upload("A question");
    for (const status of ["solved", "open"]) {
      await server.app.request(`/api/artifacts/${id}/status`, {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({ status }),
      });
    }
    expect((await listed())[0]?.status).toBe("open");
  });

  test("refuses a status this application does not define", async () => {
    const id = await upload("A question");
    const res = await server.app.request(`/api/artifacts/${id}/status`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ status: "wontfix" }),
    });
    expect(res.status).toBe(400);
  });

  test("refuses a status change without a session", async () => {
    const id = await upload("A question");
    const res = await server.app.request(`/api/artifacts/${id}/status`, {
      method: "PATCH",
      headers: { origin: TEST_BASE_URL, "content-type": "application/json" },
      body: JSON.stringify({ status: "solved" }),
    });
    expect(res.status).toBe(401);
  });

  test("filters the gallery deterministically", async () => {
    const solved = await upload("Solved one");
    await upload("Open one");
    await server.app.request(`/api/artifacts/${solved}/status`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ status: "solved" }),
    });

    expect((await listed("?status=solved")).map((item) => item.title)).toEqual(["Solved one"]);
    expect((await listed("?status=open")).map((item) => item.title)).toEqual(["Open one"]);
    expect(await listed()).toHaveLength(2);
  });
});

describe("archiving", () => {
  async function archive(id: string, archived: boolean) {
    return server.app.request(`/api/artifacts/${id}/archived`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ archived }),
    });
  }

  test("hides an archived artifact from the gallery but keeps its link working", async () => {
    const id = await upload("Old thing");
    expect(await archive(id, true)).toMatchObject({ status: 200 });

    expect(await listed()).toHaveLength(0);
    const direct = await server.app.request(`/api/artifacts/${id}`, { headers: { cookie } });
    expect(direct.status).toBe(200);
  });

  test("shows archived artifacts when they are asked for", async () => {
    const id = await upload("Old thing");
    await archive(id, true);
    expect((await listed("?archived=true")).map((item) => item.title)).toEqual(["Old thing"]);
  });

  test("records who archived it, and clears that on restore", async () => {
    const id = await upload("Old thing");
    const session = await server.auth.api.getSession({ headers: new Headers({ cookie }) });

    await archive(id, true);
    let row = server.database
      .query("select archivedAt, archivedBy from artifacts where id = ?")
      .get(id) as { archivedAt: number | null; archivedBy: string | null };
    expect(row.archivedBy).toBe(session?.user.id ?? "");
    expect(row.archivedAt).toBeGreaterThan(0);

    await archive(id, false);
    row = server.database
      .query("select archivedAt, archivedBy from artifacts where id = ?")
      .get(id) as { archivedAt: number | null; archivedBy: string | null };
    expect(row.archivedAt).toBeNull();
    expect(row.archivedBy).toBeNull();
  });

  test("keeps status and archiving independent", async () => {
    const id = await upload("Solved and archived");
    await server.app.request(`/api/artifacts/${id}/status`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ status: "solved" }),
    });
    await archive(id, true);

    const res = await server.app.request(`/api/artifacts/${id}`, { headers: { cookie } });
    const body = (await res.json()) as { artifact: { status: string; archivedAt: string | null } };
    expect(body.artifact.status).toBe("solved");
    expect(body.artifact.archivedAt).not.toBeNull();
  });
});

describe("comments", () => {
  async function comment(id: string, body: string, sessionCookie = cookie, anchor?: unknown) {
    return server.app.request(`/api/artifacts/${id}/comments`, {
      method: "POST",
      headers: headers(sessionCookie),
      body: JSON.stringify(anchor === undefined ? { body } : { body, anchor }),
    });
  }

  async function read(id: string) {
    const res = await server.app.request(`/api/artifacts/${id}/comments`, { headers: { cookie } });
    return (await res.json()) as {
      comments: {
        id: string;
        body: string;
        author: { id: string };
        anchor: typeof ANCHOR | null;
        parentId: string | null;
      }[];
    };
  }

  async function reply(id: string, parentId: string, body: string, sessionCookie = cookie) {
    return server.app.request(`/api/artifacts/${id}/comments`, {
      method: "POST",
      headers: headers(sessionCookie),
      body: JSON.stringify({ body, parentId }),
    });
  }

  test("records the author and the time, and reads back in order", async () => {
    const id = await upload("A question");
    await comment(id, "First thought");
    await comment(id, "Second thought");

    const { comments } = await read(id);
    expect(comments.map((entry) => entry.body)).toEqual(["First thought", "Second thought"]);

    const session = await server.auth.api.getSession({ headers: new Headers({ cookie }) });
    expect(comments[0]?.author.id).toBe(session?.user.id ?? "");
  });

  test("keeps every comment when two arrive at the same moment", async () => {
    const id = await upload("A question");
    await Promise.all([comment(id, "one"), comment(id, "two"), comment(id, "three")]);

    const { comments } = await read(id);
    expect(comments).toHaveLength(3);
    expect(new Set(comments.map((entry) => entry.id)).size).toBe(3);
  });

  test("refuses an empty comment", async () => {
    const id = await upload("A question");
    expect((await comment(id, "   ")).status).toBe(400);
  });

  test("refuses a comment longer than the column is meant to hold", async () => {
    const id = await upload("A question");
    // The MCP tool caps the same field in its schema. This is the other door
    // into the same store, and only the service stands in it.
    const refused = await comment(id, "x".repeat(4001));
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toContain(
      "4000",
    );
    expect((await comment(id, "y".repeat(4000))).status).toBe(201);
  });

  test("refuses a comment on an artifact that does not exist", async () => {
    expect((await comment("missing", "hello")).status).toBe(404);
  });

  test("a comment with no anchor reads back with anchor null", async () => {
    const id = await upload("A question");
    await comment(id, "No anchor here");
    expect((await read(id)).comments[0]?.anchor).toBeNull();
  });

  test("round-trips an anchor through POST and GET", async () => {
    const id = await upload("A question");
    const res = await comment(id, "Anchored", cookie, ANCHOR);
    expect(res.status).toBe(201);
    const created = (await res.json()) as { comment: { anchor: typeof ANCHOR | null } };
    expect(created.comment.anchor).toEqual(ANCHOR);

    expect((await read(id)).comments[0]?.anchor).toEqual(ANCHOR);
  });

  test("stores only quote, prefix, and suffix in the anchor column", async () => {
    const id = await upload("A question");
    const created = (await (await comment(id, "Anchored", cookie, ANCHOR)).json()) as {
      comment: { id: string };
    };
    const row = server.database
      .query("select anchor from artifactComments where id = ?")
      .get(created.comment.id) as { anchor: string };
    expect(JSON.parse(row.anchor)).toEqual(ANCHOR);
  });

  test("refuses an anchor with an empty quote", async () => {
    const id = await upload("A question");
    const res = await comment(id, "Anchored", cookie, { quote: "   ", prefix: "", suffix: "" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("quote");
  });

  test("refuses an anchor with a quote over the limit", async () => {
    const id = await upload("A question");
    const res = await comment(id, "Anchored", cookie, {
      quote: "x".repeat(501),
      prefix: "",
      suffix: "",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("500");
  });

  test("refuses an anchor whose prefix is not a string", async () => {
    const id = await upload("A question");
    const res = await comment(id, "Anchored", cookie, { quote: "text", prefix: 1, suffix: "" });
    expect(res.status).toBe(400);
  });

  test("refuses an anchor with an over-long prefix or suffix", async () => {
    const id = await upload("A question");
    const res = await comment(id, "Anchored", cookie, {
      quote: "text",
      prefix: "x".repeat(101),
      suffix: "",
    });
    expect(res.status).toBe(400);
  });

  test("accepts an anchor with empty prefix and suffix", async () => {
    const id = await upload("A question");
    const res = await comment(id, "Anchored", cookie, { quote: "text", prefix: "", suffix: "" });
    expect(res.status).toBe(201);
  });

  test("refuses to read or write comments without a session", async () => {
    const id = await upload("A question");
    expect((await server.app.request(`/api/artifacts/${id}/comments`)).status).toBe(401);
  });

  test("lets an author remove their own comment", async () => {
    const id = await upload("A question");
    const created = (await (await comment(id, "Mistake")).json()) as { comment: { id: string } };

    const res = await server.app.request(`/api/artifacts/${id}/comments/${created.comment.id}`, {
      method: "DELETE",
      headers: headers(),
    });
    expect(res.status).toBe(204);
    expect((await read(id)).comments).toHaveLength(0);
  });

  test("refuses to remove somebody else's comment", async () => {
    const id = await upload("A question");
    const created = (await (await comment(id, "Theirs")).json()) as { comment: { id: string } };

    const otherCookie = await server.signIn({
      sub: "google-subject-2",
      email: "other@acme.example",
      email_verified: true,
      name: "Another Person",
    });
    const res = await server.app.request(`/api/artifacts/${id}/comments/${created.comment.id}`, {
      method: "DELETE",
      headers: headers(otherCookie),
    });

    expect(res.status).toBe(403);
    expect((await read(id)).comments).toHaveLength(1);
  });

  test("offers no way to edit a comment", async () => {
    const id = await upload("A question");
    const created = (await (await comment(id, "As written")).json()) as {
      comment: { id: string };
    };
    const res = await server.app.request(`/api/artifacts/${id}/comments/${created.comment.id}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ body: "rewritten" }),
    });

    expect(res.status).toBe(404);
    expect((await read(id)).comments[0]?.body).toBe("As written");
  });

  test("a reply round-trips through POST and GET with its parentId", async () => {
    const id = await upload("A question");
    const root = (await (await comment(id, "Root")).json()) as { comment: { id: string } };

    const res = await reply(id, root.comment.id, "A reply");
    expect(res.status).toBe(201);
    const created = (await res.json()) as { comment: { parentId: string | null } };
    expect(created.comment.parentId).toBe(root.comment.id);

    const replied = (await read(id)).comments.find((entry) => entry.body === "A reply");
    expect(replied?.parentId).toBe(root.comment.id);
  });

  test("a root comment reads back with parentId null", async () => {
    const id = await upload("A question");
    await comment(id, "Root only");
    expect((await read(id)).comments[0]?.parentId).toBeNull();
  });

  test("refuses a reply to a reply: the client always replies to the thread's root", async () => {
    const id = await upload("A question");
    const root = (await (await comment(id, "Root")).json()) as { comment: { id: string } };
    const firstReply = (await (await reply(id, root.comment.id, "First reply")).json()) as {
      comment: { id: string };
    };

    const res = await reply(id, firstReply.comment.id, "Nested reply");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
      "the comment that started the thread",
    );
  });

  test("refuses a reply to a comment on another artifact, without leaking that it exists", async () => {
    const id = await upload("A question");
    const otherId = await upload("Another question");
    const root = (await (await comment(otherId, "Root elsewhere")).json()) as {
      comment: { id: string };
    };

    const res = await reply(id, root.comment.id, "Wrong thread");
    expect(res.status).toBe(404);
  });

  test("refuses a reply that also carries an anchor: a reply belongs to its thread, not a passage", async () => {
    const id = await upload("A question");
    const root = (await (await comment(id, "Root")).json()) as { comment: { id: string } };

    const res = await server.app.request(`/api/artifacts/${id}/comments`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ body: "Anchored reply", parentId: root.comment.id, anchor: ANCHOR }),
    });
    expect(res.status).toBe(400);
  });

  test("deleting a root deletes its replies through the foreign key cascade", async () => {
    const id = await upload("A question");
    const root = (await (await comment(id, "Root")).json()) as { comment: { id: string } };
    await reply(id, root.comment.id, "A reply");

    const res = await server.app.request(`/api/artifacts/${id}/comments/${root.comment.id}`, {
      method: "DELETE",
      headers: headers(),
    });
    expect(res.status).toBe(204);
    expect((await read(id)).comments).toHaveLength(0);
  });

  test("deleting a reply leaves the root standing", async () => {
    const id = await upload("A question");
    const root = (await (await comment(id, "Root")).json()) as { comment: { id: string } };
    const created = (await (await reply(id, root.comment.id, "A reply")).json()) as {
      comment: { id: string };
    };

    const res = await server.app.request(`/api/artifacts/${id}/comments/${created.comment.id}`, {
      method: "DELETE",
      headers: headers(),
    });
    expect(res.status).toBe(204);
    const remaining = (await read(id)).comments;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(root.comment.id);
  });
});
