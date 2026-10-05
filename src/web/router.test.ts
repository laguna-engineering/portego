import { describe, expect, test } from "bun:test";
import { artifactPath, galleryPath, memberPath, readRoute } from "./router.ts";

describe("readRoute", () => {
  test("reads the gallery and its search term from the URL", () => {
    expect(readRoute(new URL("http://app.test/"))).toEqual({
      name: "gallery",
      query: "",
      status: "open",
      archived: false,
      sort: "updated-desc",
      folderId: "root",
      tagIds: [],
    });
    expect(readRoute(new URL("http://app.test/?q=latency"))).toMatchObject({
      name: "gallery",
      query: "latency",
    });
  });

  test("reads the status and archived filters, falling back to open for a status it does not define", () => {
    expect(readRoute(new URL("http://app.test/?status=solved&archived=true"))).toMatchObject({
      status: "solved",
      archived: true,
    });
    expect(readRoute(new URL("http://app.test/?status=all"))).toMatchObject({ status: null });
    expect(readRoute(new URL("http://app.test/?status=wontfix"))).toMatchObject({ status: "open" });
  });

  test("reads the sort order, falling back to the default for one it does not define", () => {
    expect(readRoute(new URL("http://app.test/?sort=title-desc"))).toMatchObject({
      sort: "title-desc",
    });
    expect(readRoute(new URL("http://app.test/?sort=size"))).toMatchObject({
      sort: "updated-desc",
    });
  });

  test("reads the folder and every tag, ignoring empty values", () => {
    expect(readRoute(new URL("http://app.test/?folder=f1&tag=t1&tag=&tag=t2"))).toMatchObject({
      folderId: "f1",
      tagIds: ["t1", "t2"],
    });
    expect(readRoute(new URL("http://app.test/?folder="))).toMatchObject({ folderId: "root" });
  });

  test("opens on the root folder, so all artifacts is an explicit choice", () => {
    expect(readRoute(new URL("http://app.test/?folder=all"))).toMatchObject({ folderId: null });
    expect(galleryPath({ folderId: null })).toBe("/?folder=all");
    expect(galleryPath({ folderId: "root" })).toBe("/");
  });

  test("reads an artifact id, including one that was escaped", () => {
    expect(readRoute(new URL("http://app.test/a/abc-123"))).toEqual({
      name: "artifact",
      id: "abc-123",
      versionId: null,
      commentId: null,
    });
    expect(readRoute(new URL("http://app.test/a/a%2Fb"))).toEqual({
      name: "artifact",
      id: "a/b",
      versionId: null,
      commentId: null,
    });
  });

  test("reads a member's profile, and builds a path that reads back the same", () => {
    expect(readRoute(new URL("http://app.test/u/user-1"))).toEqual({
      name: "member",
      id: "user-1",
    });
    expect(readRoute(new URL(`http://app.test${memberPath("a/b")}`))).toEqual({
      name: "member",
      id: "a/b",
    });
    expect(readRoute(new URL("http://app.test/u/"))).toEqual({ name: "unknown" });
  });

  test("reads the version an artifact link points at", () => {
    expect(readRoute(new URL("http://app.test/a/abc-123?version=v%2F2"))).toEqual({
      name: "artifact",
      id: "abc-123",
      versionId: "v/2",
      commentId: null,
    });
  });

  test("still opens links copied when the view lived at /full", () => {
    expect(readRoute(new URL("http://app.test/a/abc-123/full"))).toEqual({
      name: "artifact",
      id: "abc-123",
      versionId: null,
      commentId: null,
    });
  });

  test("reports anything else as unknown, so the app can say so", () => {
    expect(readRoute(new URL("http://app.test/nope")).name).toBe("unknown");
  });
});

describe("paths", () => {
  test("keeps the filters in the gallery URL, so a link reproduces the view", () => {
    expect(galleryPath({ query: "latency p99" })).toBe("/?q=latency+p99");
    expect(galleryPath({ status: "solved", archived: true })).toBe("/?status=solved&archived=true");
    expect(galleryPath({ sort: "created-asc" })).toBe("/?sort=created-asc");
    expect(galleryPath({ status: null })).toBe("/?status=all");
    expect(galleryPath({ folderId: "f1", tagIds: ["t1", "t2"] })).toBe("/?folder=f1&tag=t1&tag=t2");
  });

  test("leaves empty filters, the default status, and the default order out of the URL", () => {
    expect(
      galleryPath({
        query: "   ",
        status: "open",
        archived: false,
        sort: "updated-desc",
        folderId: "root",
        tagIds: [],
      }),
    ).toBe("/");
  });

  test("escapes an artifact id", () => {
    expect(artifactPath("a/b")).toBe("/a/a%2Fb");
  });

  test("points at one comment when asked, and reads back the same", () => {
    const path = artifactPath("a/b", { commentId: "c/1" });
    expect(path).toBe("/a/a%2Fb?comment=c%2F1");
    expect(readRoute(new URL(path, "http://app.test"))).toEqual({
      name: "artifact",
      id: "a/b",
      versionId: null,
      commentId: "c/1",
    });
  });

  test("points at one version when asked, and reads back the same", () => {
    const path = artifactPath("a/b", { versionId: "v/2" });
    expect(path).toBe("/a/a%2Fb?version=v%2F2");
    expect(readRoute(new URL(path, "http://app.test"))).toEqual({
      name: "artifact",
      id: "a/b",
      versionId: "v/2",
      commentId: null,
    });
  });
});
