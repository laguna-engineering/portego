import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ARTIFACT_DRAG_TYPE, LONG_PRESS_MS } from "./ArtifactCard.tsx";
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
    onOpen?: (id: string) => void;
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
      onOpen={options.onOpen ?? (() => {})}
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

  test("at the root, says the artifacts may be in folders and offers all of them", async () => {
    stubFetch(() => ({ body: { items: [], nextCursor: null } }));
    const filtered: Partial<GalleryFilters>[] = [];
    renderGallery({ folderId: "root", onFilter: (filters) => filtered.push(filters) });

    expect(await screen.findByText("No artifacts outside folders.")).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "Show all artifacts" }));
    expect(filtered).toEqual([{ folderId: null }]);
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
      // The folder's name and watch level load alongside.
      if (path.startsWith("/api/artifacts")) requested.push(path);
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

  test("searches every folder, wherever the search starts", async () => {
    const requested: string[] = [];
    stubFetch((path) => {
      requested.push(path);
      return { body: { items: [artifact()], nextCursor: null } };
    });
    renderGallery({ folderId: "root", query: "chart" });

    await screen.findByText("Sales chart");
    const search = new URL(requested[0] ?? "", "http://app.test").searchParams;
    expect(search.get("q")).toBe("chart");
    expect(search.has("folderId")).toBe(false);
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

describe("dragging", () => {
  test("a card carries its artifact id, so the library can file it in a folder", async () => {
    stubFetch(() => ({ body: { items: [artifact({ id: "a1" })], nextCursor: null } }));
    renderGallery();

    const data = new Map<string, string>();
    fireEvent.dragStart(await screen.findByRole("link", { name: /Sales chart/ }), {
      dataTransfer: {
        setData: (type: string, value: string) => data.set(type, value),
        setDragImage: () => {},
      },
    });

    expect(data.get(ARTIFACT_DRAG_TYPE)).toBe("a1");
  });
});

describe("selecting", () => {
  /** Serves the artifacts and records each organization change. */
  function stubSelection(
    items = ["Alpha", "Beta", "Gamma"].map((title) => artifact({ id: title.toLowerCase(), title })),
  ) {
    const changes: { id: string; body: Record<string, unknown> }[] = [];
    stubFetch((path, init) => {
      const status = path.match(/^\/api\/artifacts\/([^/]+)\/status$/);
      if (status?.[1] && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        changes.push({ id: status[1], body });
        const current = items.find((item) => item.id === status[1]);
        return { body: { artifact: { ...current, status: body.status } } };
      }
      const change = path.match(/^\/api\/artifacts\/([^/]+)\/organization$/);
      if (change?.[1] && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        changes.push({ id: change[1], body });
        const current = items.find((item) => item.id === change[1]);
        return {
          body: {
            artifact: {
              ...current,
              ...("tagIds" in body
                ? { tags: (body.tagIds as string[]).map((id) => ({ id, name: id })) }
                : {}),
              ...("folderId" in body ? { folder: { id: body.folderId, name: "Lampo" } } : {}),
            },
          },
        };
      }
      if (path === "/api/folders") {
        return {
          body: { folders: [{ id: "lampo", name: "Lampo", parentId: null, artifactCount: 0 }] },
        };
      }
      if (path === "/api/tags") return { body: { tags: [{ id: "review", name: "review" }] } };
      return { body: { items, nextCursor: null } };
    });
    return changes;
  }

  function card(title: string): HTMLElement {
    return screen.getByRole("link", { name: new RegExp(`^${title}`) });
  }

  /** Holds a card down long enough to select it, then lets go. */
  async function longPress(title: string) {
    const link = card(title);
    fireEvent.pointerDown(link, { button: 0, clientX: 10, clientY: 10 });
    await act(() => new Promise((resolve) => setTimeout(resolve, LONG_PRESS_MS + 50)));
    fireEvent.pointerUp(link);
    fireEvent.click(link);
  }

  /** Waits for the copy of the card used as the drag image to be removed. */
  async function dropDragImage() {
    await act(() => new Promise((resolve) => setTimeout(resolve)));
  }

  function dragData() {
    const data = new Map<string, string>();
    const images: HTMLElement[] = [];
    return {
      data,
      images,
      dataTransfer: {
        dropEffect: "none",
        setData: (type: string, value: string) => data.set(type, value),
        setDragImage: (image: HTMLElement) => images.push(image),
      },
    };
  }

  test("a long press selects a card without opening it, and later clicks add or remove cards", async () => {
    stubSelection();
    const opened: string[] = [];
    renderGallery({ onOpen: (id) => opened.push(id) });
    await screen.findByText("Alpha");

    await longPress("Alpha");
    expect(opened).toEqual([]);
    expect(screen.getByText("1 selected")).toBeDefined();
    expect(card("Alpha").textContent).toContain("selected");

    await userEvent.click(card("Gamma"));
    expect(screen.getByText("2 selected")).toBeDefined();

    await userEvent.click(card("Alpha"));
    expect(screen.getByText("1 selected")).toBeDefined();

    // With the last card removed, a click opens an artifact again.
    await userEvent.click(card("Gamma"));
    expect(screen.queryByRole("toolbar", { name: "Selected artifacts" })).toBeNull();
    await userEvent.click(card("Beta"));
    expect(opened).toEqual(["beta"]);
  });

  test("a press that moves, as a scroll does, selects nothing", async () => {
    stubSelection();
    renderGallery();
    await screen.findByText("Alpha");

    const link = card("Alpha");
    fireEvent.pointerDown(link, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(link, { clientX: 10, clientY: 40 });
    await act(() => new Promise((resolve) => setTimeout(resolve, LONG_PRESS_MS + 50)));

    expect(screen.queryByRole("toolbar", { name: "Selected artifacts" })).toBeNull();
  });

  test("Escape and the clear button end the selection", async () => {
    stubSelection();
    renderGallery();
    await screen.findByText("Alpha");

    await longPress("Alpha");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByText("1 selected")).toBeNull();

    await longPress("Beta");
    await userEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.queryByText("1 selected")).toBeNull();
  });

  test("dragging a selected card carries every selected artifact and says how many others come along", async () => {
    stubSelection();
    renderGallery();
    await screen.findByText("Alpha");
    await longPress("Alpha");
    await userEvent.click(card("Gamma"));

    const drag = dragData();
    fireEvent.dragStart(card("Gamma"), { dataTransfer: drag.dataTransfer });

    // The card under the pointer comes first.
    expect(drag.data.get(ARTIFACT_DRAG_TYPE)).toBe("gamma,alpha");
    expect(drag.images[0]?.textContent).toContain("+ 1 other");
    await dropDragImage();
    expect(drag.images[0]?.isConnected).toBe(false);
  });

  test("dragging a card outside the selection carries only that card", async () => {
    stubSelection();
    renderGallery();
    await screen.findByText("Alpha");
    await longPress("Alpha");

    const drag = dragData();
    fireEvent.dragStart(card("Beta"), { dataTransfer: drag.dataTransfer });

    expect(drag.data.get(ARTIFACT_DRAG_TYPE)).toBe("beta");
    expect(drag.images).toEqual([]);
  });

  test("a dropped selection ends the selection, and a cancelled drag keeps it", async () => {
    stubSelection();
    renderGallery();
    await screen.findByText("Alpha");
    await longPress("Alpha");
    await userEvent.click(card("Beta"));

    fireEvent.dragStart(card("Alpha"), { dataTransfer: dragData().dataTransfer });
    await dropDragImage();
    fireEvent.dragEnd(card("Alpha"), { dataTransfer: { dropEffect: "none" } });
    expect(screen.getByText("2 selected")).toBeDefined();

    fireEvent.dragStart(card("Alpha"), { dataTransfer: dragData().dataTransfer });
    await dropDragImage();
    fireEvent.dragEnd(card("Alpha"), { dataTransfer: { dropEffect: "move" } });
    expect(screen.queryByText("2 selected")).toBeNull();
  });

  test("moves every selected artifact to the chosen folder, then ends the selection", async () => {
    const changes = stubSelection();
    renderGallery();
    await screen.findByText("Alpha");
    await longPress("Alpha");
    await userEvent.click(card("Gamma"));

    await userEvent.click(screen.getByRole("button", { name: "Move to folder" }));
    const dialog = await screen.findByRole("dialog", { name: "Move to folder" });
    await userEvent.click(await within(dialog).findByRole("button", { name: "Lampo" }));

    await waitFor(() => expect(screen.queryByText("2 selected")).toBeNull());
    expect(changes.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: "alpha", body: { folderId: "lampo" } },
      { id: "gamma", body: { folderId: "lampo" } },
    ]);
  });

  test("a tag on some of the selection is marked mixed, and choosing it adds it to the rest", async () => {
    const changes = stubSelection([
      artifact({ id: "alpha", title: "Alpha", tags: [{ id: "review", name: "review" }] }),
      artifact({ id: "beta", title: "Beta" }),
    ]);
    renderGallery();
    await screen.findByText("Alpha");
    await longPress("Alpha");
    await userEvent.click(card("Beta"));

    await userEvent.click(screen.getByRole("button", { name: "Tags" }));
    const dialog = await screen.findByRole("dialog", { name: "Tags" });
    const review = await within(dialog).findByRole("button", { name: "review" });
    expect(review.getAttribute("aria-pressed")).toBe("mixed");

    await userEvent.click(review);
    await waitFor(() => expect(review.getAttribute("aria-pressed")).toBe("true"));
    expect(changes).toEqual([{ id: "beta", body: { tagIds: ["review"] } }]);

    // Once every selected artifact has the tag, choosing it takes it off all of them.
    await userEvent.click(review);
    await waitFor(() => expect(review.getAttribute("aria-pressed")).toBe("false"));
    expect(changes.slice(1).sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: "alpha", body: { tagIds: [] } },
      { id: "beta", body: { tagIds: [] } },
    ]);
  });

  test("select all takes in every loaded card, and select none ends the selection", async () => {
    stubSelection();
    renderGallery();
    await screen.findByText("Alpha");
    await longPress("Alpha");

    await userEvent.click(screen.getByRole("button", { name: "Select all" }));
    expect(screen.getByText("3 selected")).toBeDefined();

    await userEvent.click(screen.getByRole("button", { name: "Select none" }));
    expect(screen.queryByRole("toolbar", { name: "Selected artifacts" })).toBeNull();
  });

  test("marks the open artifacts in the selection solved, and keeps the selection so it can be undone", async () => {
    const changes = stubSelection([
      artifact({ id: "alpha", title: "Alpha", status: "solved" }),
      artifact({ id: "beta", title: "Beta" }),
    ]);
    renderGallery();
    await screen.findByText("Alpha");
    await longPress("Alpha");
    await userEvent.click(card("Beta"));

    await userEvent.click(screen.getByRole("button", { name: "Mark solved" }));
    // Alpha is already solved, so only Beta changes.
    await screen.findByRole("button", { name: "Reopen" });
    expect(changes).toEqual([{ id: "beta", body: { status: "solved" } }]);
    expect(screen.getByText("2 selected")).toBeDefined();

    await userEvent.click(screen.getByRole("button", { name: "Reopen" }));
    await screen.findByRole("button", { name: "Mark solved" });
    expect(changes.slice(1).sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: "alpha", body: { status: "open" } },
      { id: "beta", body: { status: "open" } },
    ]);
  });

  test("says so when a status change fails, and leaves the cards as they were", async () => {
    stubFetch((_path, init) => {
      if (init?.method === "PATCH") {
        return {
          status: 404,
          body: { error: { code: "NOT_FOUND", message: "Artifact not found." } },
        };
      }
      return { body: { items: [artifact({ id: "alpha", title: "Alpha" })], nextCursor: null } };
    });
    renderGallery();
    await screen.findByText("Alpha");
    await longPress("Alpha");

    await userEvent.click(screen.getByRole("button", { name: "Mark solved" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Artifact not found.");
    expect(screen.getByRole("button", { name: "Mark solved" })).toBeDefined();
  });
});

describe("watching a folder", () => {
  const FOLDERS = [
    { id: "research", name: "Research", parentId: null, artifactCount: 2 },
    { id: "pricing", name: "Pricing", parentId: "research", artifactCount: 3 },
    { id: "q3", name: "Q3", parentId: "pricing", artifactCount: 2 },
    { id: "design", name: "Design", parentId: null, artifactCount: 4 },
  ];

  test("names the open folder with its parents and watches it with everything below it", async () => {
    const sent: [string, unknown][] = [];
    stubFetch((path, init) => {
      if (path === "/api/folders") return { body: { folders: FOLDERS, rootArtifactCount: 0 } };
      if (path.startsWith("/api/activity/subscriptions/")) {
        const level = init?.method === "PUT" ? JSON.parse(String(init.body)).level : null;
        if (level) sent.push([path, { level }]);
        return { body: { subscription: { level, reason: null, inherited: null } } };
      }
      return { body: { items: [], nextCursor: null } };
    });
    renderGallery({ folderId: "pricing" });

    const heading = await screen.findByRole("heading", { name: /Pricing/ });
    expect(heading.textContent).toBe("Research › Pricing");
    await userEvent.click(screen.getByRole("button", { name: "Watch folder" }));
    const dialog = screen.getByRole("dialog", { name: "Watch folder" });
    // Pricing and Q3, and not its parent or Design.
    expect(
      within(dialog).getByText(
        "Covers 5 artifacts in Pricing and its 1 subfolder, and anything added later.",
      ),
    ).toBeDefined();

    await userEvent.click(within(dialog).getByRole("button", { name: /^All activity/ }));

    expect(sent).toEqual([["/api/activity/subscriptions/folders/pricing", { level: "all" }]]);
    expect(await screen.findByRole("button", { name: "Watching" })).toBeDefined();
  });

  test("shows no folder control for all artifacts or the root", async () => {
    stubFetch(() => ({ body: { items: [], nextCursor: null } }));
    const { rerender } = renderGallery();
    await screen.findByText("No artifacts yet.");
    expect(screen.queryByRole("button", { name: "Watch folder" })).toBeNull();

    rerender(
      <Gallery
        filters={{
          query: "",
          status: null,
          archived: false,
          sort: "updated-desc",
          folderId: "root",
          tagIds: [],
        }}
        onFilter={() => {}}
        onOpen={() => {}}
        onUpload={() => {}}
      />,
    );
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "Watch folder" })).toBeNull();
  });
});
