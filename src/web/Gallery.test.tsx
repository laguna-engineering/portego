import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Gallery } from "./Gallery.tsx";
import type { GalleryFilters, GallerySort } from "./router.ts";
import { artifact, restoreFetch, StubEventSource, stubFetch, stubFetchWith } from "./testing.ts";

afterEach(restoreFetch);
beforeEach(() => StubEventSource.install());

/** Announces a change and waits for whatever the page does about it. */
async function announce(event: Parameters<StubEventSource["send"]>[0]) {
  const stream = StubEventSource.last;
  if (!stream) throw new Error("No stream was opened");
  await act(async () => {
    stream.send(event);
  });
}

function renderGallery(
  options: {
    query?: string;
    status?: "open" | "solved" | null;
    archived?: boolean;
    sort?: GallerySort;
    folderId?: string | null;
    tagIds?: string[];
    onFilter?: (filters: Partial<GalleryFilters>) => void;
  } = {},
) {
  return render(
    <Gallery
      filters={{
        query: options.query ?? "",
        status: options.status ?? null,
        archived: options.archived ?? false,
        sort: options.sort ?? "updated-desc",
        folderId: options.folderId ?? null,
        tagIds: options.tagIds ?? [],
      }}
      onFilter={options.onFilter ?? (() => {})}
      onOpen={() => {}}
      onUpload={() => {}}
    />,
  );
}

describe("empty states", () => {
  test("invites the first upload when there is nothing at all", async () => {
    stubFetch(() => ({ body: { items: [], nextCursor: null } }));
    renderGallery();

    expect(await screen.findByText("No artifacts yet.")).toBeDefined();
    expect(screen.getByRole("button", { name: "Upload the first one" })).toBeDefined();
  });

  test("says what found nothing when a search matches no artifact", async () => {
    stubFetch(() => ({ body: { items: [], nextCursor: null } }));
    renderGallery({ query: "latency" });

    expect(await screen.findByText(/Nothing matches/)).toBeDefined();
    expect(screen.getByText(/latency/)).toBeDefined();
  });

  test("offers the whole gallery when a folder or tag filter matches nothing, since there may be artifacts elsewhere", async () => {
    stubFetch(() => ({ body: { items: [], nextCursor: null } }));
    const filtered: Partial<GalleryFilters>[] = [];
    renderGallery({ folderId: "folder-1", onFilter: (filters) => filtered.push(filters) });

    const showAll = await screen.findByRole("button", { name: "Show all artifacts" });
    expect(screen.queryByText("No artifacts yet.")).toBeNull();
    await userEvent.click(showAll);
    expect(filtered).toEqual([{ folderId: null, tagIds: [] }]);
  });

  test("offers to clear a search that found nothing", async () => {
    stubFetch(() => ({ body: { items: [], nextCursor: null } }));
    const filtered: Partial<GalleryFilters>[] = [];
    renderGallery({ query: "latency", onFilter: (filters) => filtered.push(filters) });

    await userEvent.click(await screen.findByRole("button", { name: "Clear the search" }));
    expect(filtered).toEqual([{ query: "" }]);
  });
});

describe("failures", () => {
  test("reports a failure and offers to retry", async () => {
    let attempts = 0;
    stubFetch(() => {
      attempts += 1;
      return attempts === 1
        ? { status: 500, body: { error: { code: "INTERNAL", message: "Something went wrong." } } }
        : { body: { items: [artifact()], nextCursor: null } };
    });
    renderGallery();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Something went wrong.");

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Sales chart")).toBeDefined();
  });
});

describe("filters", () => {
  test("asks the server for the selected status", async () => {
    const requested: string[] = [];
    stubFetch((path) => {
      requested.push(path);
      return { body: { items: [], nextCursor: null } };
    });
    renderGallery({ status: "solved" });

    await screen.findByText("No artifacts yet.");
    expect(requested[0]).toContain("status=solved");
  });

  test("asks the server for the selected folder and every selected tag, on later pages too", async () => {
    const requested: string[] = [];
    stubFetch((path) => {
      requested.push(path);
      return {
        body: path.includes("cursor=")
          ? { items: [], nextCursor: null }
          : { items: [artifact()], nextCursor: "next" },
      };
    });
    renderGallery({ folderId: "folder-1", tagIds: ["tag-1", "tag-2"] });

    await userEvent.click(await screen.findByRole("button", { name: "Load more" }));
    await waitFor(() => expect(requested).toHaveLength(2));
    for (const path of requested) {
      const search = new URL(path, "http://app.test").searchParams;
      expect(search.get("folderId")).toBe("folder-1");
      expect(search.getAll("tagId")).toEqual(["tag-1", "tag-2"]);
    }
  });

  test("leaves archived artifacts out unless they are asked for", async () => {
    const requested: string[] = [];
    stubFetch((path) => {
      requested.push(path);
      return { body: { items: [], nextCursor: null } };
    });
    const { rerender } = renderGallery();

    await screen.findByText("No artifacts yet.");
    expect(requested[0]).not.toContain("archived");

    rerender(
      <Gallery
        filters={{
          query: "",
          status: null,
          archived: true,
          sort: "updated-desc",
          folderId: null,
          tagIds: [],
        }}
        onFilter={() => {}}
        onOpen={() => {}}
        onUpload={() => {}}
      />,
    );
    await waitFor(() => expect(requested.at(-1)).toContain("archived=true"));
  });

  test("asks the server for the chosen order and leaves the default out", async () => {
    const requested: string[] = [];
    stubFetch((path) => {
      requested.push(path);
      return { body: { items: [], nextCursor: null } };
    });
    const { rerender } = renderGallery();

    await screen.findByText("No artifacts yet.");
    expect(requested[0]).not.toContain("sort");

    rerender(
      <Gallery
        filters={{
          query: "",
          status: null,
          archived: false,
          sort: "title-asc",
          folderId: null,
          tagIds: [],
        }}
        onFilter={() => {}}
        onOpen={() => {}}
        onUpload={() => {}}
      />,
    );
    await waitFor(() => expect(requested.at(-1)).toContain("sort=title-asc"));
  });

  test("keeps the cards in place while another folder loads, so nothing on the page moves", async () => {
    let release: () => void = () => {};
    stubFetchWith((path) => {
      const items = path.includes("folderId")
        ? [artifact({ id: "artifact-2", title: "In the folder" })]
        : [artifact({ title: "First" })];
      const response = Response.json({ items, nextCursor: null });
      if (!path.includes("folderId")) return Promise.resolve(response);
      return new Promise((resolve) => {
        release = () => resolve(response);
      });
    });
    const { rerender } = renderGallery();
    expect(await screen.findByText("First")).toBeDefined();

    rerender(
      <Gallery
        filters={{
          query: "",
          status: null,
          archived: false,
          sort: "updated-desc",
          folderId: "folder-1",
          tagIds: [],
        }}
        onFilter={() => {}}
        onOpen={() => {}}
        onUpload={() => {}}
      />,
    );

    const cards = screen.getByRole("list");
    await waitFor(() => expect(cards.getAttribute("aria-busy")).toBe("true"));
    // A line above the cards would push them down, then back up on arrival.
    expect(screen.queryByText("Loading artifacts...")).toBeNull();
    expect(screen.getByText("First")).toBeDefined();

    await act(async () => release());
    expect(await screen.findByText("In the folder")).toBeDefined();
    expect(cards.getAttribute("aria-busy")).toBe("false");
  });

  test("reports the order a person picked, so the URL can carry it", async () => {
    stubFetch(() => ({ body: { items: [], nextCursor: null } }));
    const filtered: Partial<GalleryFilters>[] = [];
    renderGallery({ onFilter: (filters) => filtered.push(filters) });

    await userEvent.selectOptions(await screen.findByLabelText("Sort by"), "created-asc");
    expect(filtered).toEqual([{ sort: "created-asc" }]);
  });

  test("reports the filter a person picked, so the URL can carry it", async () => {
    stubFetch(() => ({ body: { items: [], nextCursor: null } }));
    const filtered: Partial<GalleryFilters>[] = [];
    renderGallery({ onFilter: (filters) => filtered.push(filters) });

    await userEvent.click(await screen.findByRole("button", { name: "Solved" }));
    await userEvent.click(screen.getByLabelText("Show archived"));
    expect(filtered).toEqual([{ status: "solved" }, { archived: true }]);
  });

  test("marks the selected status for a screen reader", async () => {
    stubFetch(() => ({ body: { items: [], nextCursor: null } }));
    renderGallery({ status: "open" });

    const open = await screen.findByRole("button", { name: "Open" });
    expect(open.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("false");
  });
});

describe("listing", () => {
  test("shows a card with the title, creator, and size", async () => {
    stubFetch(() => ({ body: { items: [artifact()], nextCursor: null } }));
    renderGallery();

    expect(await screen.findByText("Sales chart")).toBeDefined();
    expect(screen.getByText(/A Person/)).toBeDefined();
    expect(screen.getByText(/2 KiB/)).toBeDefined();
  });

  test("links the card to the artifact, so a modified click opens it in a new tab", async () => {
    stubFetch(() => ({ body: { items: [artifact()], nextCursor: null } }));
    const { container } = renderGallery();

    await screen.findByText("Sales chart");
    const link = container.querySelector(".card-link");
    expect(link?.getAttribute("href")).toBe("/a/artifact-1");
    // The tab a reader opens themselves gets no handle on this one.
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  test("marks a solved or archived artifact on its card", async () => {
    stubFetch(() => ({
      body: {
        items: [artifact({ status: "solved", archivedAt: new Date().toISOString() })],
        nextCursor: null,
      },
    }));
    renderGallery({ archived: true });

    expect(await screen.findByText("solved")).toBeDefined();
    expect(screen.getByText("archived")).toBeDefined();
  });

  test("shows a version badge only when the artifact has more than one version", async () => {
    stubFetch(() => ({
      body: { items: [artifact({ versionCount: 3 })], nextCursor: null },
    }));
    renderGallery();

    expect(await screen.findByText("v3")).toBeDefined();
  });

  test("shows no version badge for an artifact with a single version", async () => {
    stubFetch(() => ({ body: { items: [artifact()], nextCursor: null } }));
    renderGallery();

    await screen.findByText("Sales chart");
    expect(screen.queryByText(/^v\d+$/)).toBeNull();
  });

  test("renders no uploaded markup, only metadata", async () => {
    stubFetch(() => ({
      body: {
        items: [artifact({ description: "<img src=x onerror=alert(1)>" })],
        nextCursor: null,
      },
    }));
    const { container } = renderGallery();

    await screen.findByText("Sales chart");
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  test("loads the next page only when asked", async () => {
    const pages = [
      { items: [artifact({ id: "a1", title: "First" })], nextCursor: "cursor-1" },
      { items: [artifact({ id: "a2", title: "Second" })], nextCursor: null },
    ];
    stubFetch((path) => ({ body: path.includes("cursor=") ? pages[1] : pages[0] }));
    renderGallery();

    expect(await screen.findByText("First")).toBeDefined();
    expect(screen.queryByText("Second")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Second")).toBeDefined();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Load more" })).toBeNull());
  });

  test("asks the server for the search term instead of filtering in the browser", async () => {
    const requested: string[] = [];
    stubFetch((path) => {
      requested.push(path);
      return { body: { items: [], nextCursor: null } };
    });
    renderGallery({ query: "latency" });

    await screen.findByText(/Nothing matches/);
    expect(requested[0]).toContain("q=latency");
  });
});

describe("live updates", () => {
  test("brings in an artifact somebody else uploaded, with no reload", async () => {
    let listed = [artifact({ id: "artifact-1", title: "First" })];
    stubFetch(() => ({ body: { items: listed, nextCursor: null } }));
    renderGallery();
    expect(await screen.findByText("First")).toBeDefined();

    listed = [artifact({ id: "artifact-2", title: "Second" }), ...listed];
    await announce({ type: "artifact.created", id: "artifact-2" });

    expect(await screen.findByText("Second")).toBeDefined();
    expect(screen.getByText("First")).toBeDefined();
  });

  test("keeps the cards on screen while it refreshes them", async () => {
    stubFetch(() => ({ body: { items: [artifact({ title: "First" })], nextCursor: null } }));
    renderGallery();
    expect(await screen.findByText("First")).toBeDefined();

    await announce({ type: "artifact.changed", id: "artifact-1" });

    // A reader watching the gallery should see no flicker back to a loading
    // message for a refresh they did not ask for.
    expect(screen.queryByText("Loading artifacts...")).toBeNull();
    expect(screen.getByText("First")).toBeDefined();
  });

  test("asks before rebuilding a gallery the reader has paged through", async () => {
    stubFetch((path) => ({
      body: path.includes("cursor")
        ? { items: [artifact({ id: "artifact-2", title: "Second" })], nextCursor: null }
        : { items: [artifact({ id: "artifact-1", title: "First" })], nextCursor: "c1" },
    }));
    renderGallery();
    await screen.findByText("First");
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByText("Second");

    await announce({ type: "artifact.created", id: "artifact-3" });

    expect(await screen.findByText("Someone has made a change.")).toBeDefined();
    // Both pages are still there. Nothing moved under the reader.
    expect(screen.getByText("First")).toBeDefined();
    expect(screen.getByText("Second")).toBeDefined();

    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.queryByText("Second")).toBeNull());
  });

  test("leaves the gallery alone for a comment, which no card shows", async () => {
    let calls = 0;
    stubFetch(() => {
      calls += 1;
      return { body: { items: [artifact({ title: "First" })], nextCursor: null } };
    });
    renderGallery();
    await screen.findByText("First");
    const before = calls;

    await announce({ type: "comment.changed", artifactId: "artifact-1" });

    expect(calls).toBe(before);
  });

  test("catches up after the stream comes back", async () => {
    let listed = [artifact({ id: "artifact-1", title: "First" })];
    stubFetch(() => ({ body: { items: listed, nextCursor: null } }));
    renderGallery();
    await screen.findByText("First");

    // Whatever happened while the connection was down was never announced.
    listed = [artifact({ id: "artifact-2", title: "Second" })];
    await announce({ type: "reconnected" });

    expect(await screen.findByText("Second")).toBeDefined();
  });
});
