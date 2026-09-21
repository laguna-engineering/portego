import { describe, expect, test } from "bun:test";
import { artifactPath, fullScreenPath, galleryPath, readRoute } from "./router.ts";

describe("readRoute", () => {
  test("reads the gallery and its search term from the URL", () => {
    expect(readRoute(new URL("http://app.test/"))).toEqual({
      name: "gallery",
      query: "",
      status: null,
      archived: false,
      sort: "updated-desc",
    });
    expect(readRoute(new URL("http://app.test/?q=latency"))).toMatchObject({
      name: "gallery",
      query: "latency",
    });
  });

  test("reads the status and archived filters, ignoring a status it does not define", () => {
    expect(readRoute(new URL("http://app.test/?status=solved&archived=true"))).toMatchObject({
      status: "solved",
      archived: true,
    });
    expect(readRoute(new URL("http://app.test/?status=wontfix"))).toMatchObject({ status: null });
  });

  test("reads the sort order, falling back to the default for one it does not define", () => {
    expect(readRoute(new URL("http://app.test/?sort=title-desc"))).toMatchObject({
      sort: "title-desc",
    });
    expect(readRoute(new URL("http://app.test/?sort=size"))).toMatchObject({
      sort: "updated-desc",
    });
  });

  test("reads an artifact id, including one that was escaped", () => {
    expect(readRoute(new URL("http://app.test/a/abc-123"))).toEqual({
      name: "artifact",
      id: "abc-123",
    });
    expect(readRoute(new URL("http://app.test/a/a%2Fb"))).toEqual({ name: "artifact", id: "a/b" });
  });

  test("reads the full-screen view as its own route, not as an artifact id", () => {
    expect(readRoute(new URL("http://app.test/a/abc-123/full"))).toEqual({
      name: "artifact-full",
      id: "abc-123",
    });
    // The detail page keeps the bare path. Only `/full` opens the frame alone.
    expect(readRoute(new URL("http://app.test/a/abc-123")).name).toBe("artifact");
  });

  test("reports anything else as unknown, so the app can say so", () => {
    expect(readRoute(new URL("http://app.test/nope")).name).toBe("unknown");
  });
});

describe("paths", () => {
  test("builds a full-screen path the router reads back", () => {
    expect(fullScreenPath("abc-123")).toBe("/a/abc-123/full");
    expect(readRoute(new URL(`http://app.test${fullScreenPath("a/b")}`))).toEqual({
      name: "artifact-full",
      id: "a/b",
    });
  });

  test("keeps the filters in the gallery URL, so a link reproduces the view", () => {
    expect(galleryPath({ query: "latency p99" })).toBe("/?q=latency+p99");
    expect(galleryPath({ status: "solved", archived: true })).toBe("/?status=solved&archived=true");
    expect(galleryPath({ sort: "created-asc" })).toBe("/?sort=created-asc");
  });

  test("leaves empty filters and the default order out of the URL", () => {
    expect(galleryPath({ query: "   ", status: null, archived: false, sort: "updated-desc" })).toBe(
      "/",
    );
  });

  test("escapes an artifact id", () => {
    expect(artifactPath("a/b")).toBe("/a/a%2Fb");
  });
});
