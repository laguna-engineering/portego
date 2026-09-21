import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TEST_BASE_URL } from "../auth/testing.ts";
import { createTestServer, htmlFile, type TestServer } from "../testing.ts";
import type { ChangeEvent } from "./bus.ts";

let server: TestServer;
let cookie: string;

beforeAll(async () => {
  server = await createTestServer();
  cookie = await server.signIn();
});

afterAll(() => server.cleanup());

/** Runs the request with a listener attached, and returns what it announced. */
async function announced(run: () => Promise<Response> | Response): Promise<ChangeEvent[]> {
  const seen: ChangeEvent[] = [];
  const unsubscribe = server.events.subscribe((event) => seen.push(event));
  try {
    await run();
  } finally {
    unsubscribe();
  }
  return seen;
}

function upload() {
  const form = new FormData();
  form.set("file", htmlFile("<h1>A chart</h1>", "chart.html"));
  return server.app.request("/api/artifacts", {
    method: "POST",
    headers: { cookie, origin: TEST_BASE_URL },
    body: form,
  });
}

async function uploadedId(): Promise<string> {
  const body = (await (await upload()).json()) as { artifact: { id: string } };
  return body.artifact.id;
}

function mutate(path: string, method: string, body?: unknown) {
  return server.app.request(path, {
    method,
    headers: {
      cookie,
      origin: TEST_BASE_URL,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/**
 * Every write a person can make has to reach the other people looking at it.
 * A path added later without an announcement is the failure these cover.
 */
describe("what a write announces", () => {
  test("an upload", async () => {
    const seen = await announced(upload);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.type).toBe("artifact.created");
  });

  test("a status change", async () => {
    const id = await uploadedId();
    const seen = await announced(() =>
      mutate(`/api/artifacts/${id}/status`, "PATCH", { status: "solved" }),
    );
    expect(seen).toEqual([{ type: "artifact.changed", id }]);
  });

  test("an archive and a restore", async () => {
    const id = await uploadedId();
    const archived = await announced(() =>
      mutate(`/api/artifacts/${id}/archived`, "PATCH", { archived: true }),
    );
    const restored = await announced(() =>
      mutate(`/api/artifacts/${id}/archived`, "PATCH", { archived: false }),
    );
    expect(archived).toEqual([{ type: "artifact.changed", id }]);
    expect(restored).toEqual([{ type: "artifact.changed", id }]);
  });

  test("a comment, and its removal", async () => {
    const id = await uploadedId();
    let commentId = "";

    const added = await announced(async () => {
      const res = await mutate(`/api/artifacts/${id}/comments`, "POST", { body: "A thought" });
      const created = (await res.clone().json()) as { comment: { id: string } };
      commentId = created.comment.id;
      return res;
    });
    const removed = await announced(() =>
      mutate(`/api/artifacts/${id}/comments/${commentId}`, "DELETE"),
    );

    expect(added).toEqual([{ type: "comment.changed", artifactId: id }]);
    expect(removed).toEqual([{ type: "comment.changed", artifactId: id }]);
  });

  test("nothing, when the write was refused", async () => {
    const id = await uploadedId();
    const seen = await announced(() =>
      mutate(`/api/artifacts/${id}/comments`, "POST", { body: "   " }),
    );
    expect(seen).toEqual([]);
  });

  test("nothing, when a read runs", async () => {
    const id = await uploadedId();
    const seen = await announced(() =>
      server.app.request(`/api/artifacts/${id}`, { headers: { cookie } }),
    );
    expect(seen).toEqual([]);
  });
});
