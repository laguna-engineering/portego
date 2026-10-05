import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ActivityFeed, ActivityItem } from "./api.ts";
import { NotificationBell } from "./NotificationBell.tsx";
import type { ArtifactTarget } from "./router.ts";
import { restoreFetch, StubEventSource, stubFetchWith } from "./testing.ts";

afterEach(restoreFetch);
beforeEach(() => StubEventSource.install());

const EARLIER = "2026-09-28T10:00:00.000Z";
const READ = "2026-09-28T11:00:00.000Z";
const LATER = "2026-09-28T12:00:00.000Z";

function item(overrides: Partial<ActivityItem> & Pick<ActivityItem, "kind">): ActivityItem {
  return {
    id: "item-1",
    createdAt: LATER,
    actor: { id: "user-2", name: "B Person" },
    artifact: { id: "artifact-1", title: "Plan" },
    reason: { kind: "uploaded" },
    ...overrides,
  } as ActivityItem;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Serves `server.feed` and counts feed loads and read requests. A read moves the marker the
 * way the server would. Setting `hold` keeps the next feed response waiting.
 */
function stubServer(feed: ActivityFeed, options: { failRead?: boolean } = {}) {
  const server = {
    feed,
    loads: 0,
    reads: 0,
    held: null as (() => void) | null,
    hold: false,
  };
  stubFetchWith((path, init) => {
    if (path === "/api/activity/read" && init?.method === "POST") {
      server.reads += 1;
      if (options.failRead) {
        return Promise.resolve(json({ error: { code: "OFFLINE", message: "No." } }, 503));
      }
      server.feed = { ...server.feed, readAt: LATER };
      return Promise.resolve(json({ readAt: LATER }));
    }
    server.loads += 1;
    const answer = json(server.feed);
    if (!server.hold) return Promise.resolve(answer);
    server.hold = false;
    return new Promise((resolve) => {
      server.held = () => resolve(answer);
    });
  });
  return server;
}

function renderBell(onOpenArtifact: (id: string, target?: ArtifactTarget) => void = () => {}) {
  return render(<NotificationBell onOpenArtifact={onOpenArtifact} />);
}

async function announce() {
  await act(async () => {
    StubEventSource.last?.send({ type: "comment.changed", artifactId: "artifact-1" });
  });
}

const bell = () => screen.getByRole("button", { name: /^Notifications/ });

describe("dot", () => {
  test("shows when something happened since the list was last opened", async () => {
    stubServer({ items: [item({ kind: "artifact.created" })], readAt: READ });
    renderBell();

    expect(await screen.findByRole("button", { name: "Notifications, unread" })).toBeDefined();
    expect(bell().hasAttribute("data-dot")).toBe(true);
  });

  test("stays off when everything listed was there at the last opening", async () => {
    stubServer({ items: [item({ kind: "artifact.created", createdAt: EARLIER })], readAt: READ });
    renderBell();
    await act(async () => {});

    expect(bell().hasAttribute("data-dot")).toBe(false);
  });

  test("appears when the stream announces a change, and stays until the list is opened", async () => {
    const server = stubServer({ items: [], readAt: READ });
    renderBell();
    await act(async () => {});
    expect(bell().hasAttribute("data-dot")).toBe(false);

    server.feed = { items: [item({ kind: "comment.created", reply: false })], readAt: READ };
    await announce();

    await waitFor(() => expect(bell().hasAttribute("data-dot")).toBe(true));
    await act(async () => {});
    expect(bell().hasAttribute("data-dot")).toBe(true);
  });

  test("reloads for an entry change only when it reaches the feed, so votes do not refetch it", async () => {
    const server = stubServer({ items: [], readAt: READ });
    renderBell();
    await act(async () => {});
    expect(server.loads).toBe(1);

    server.feed = { items: [item({ kind: "entry.changed", key: "note:P-01" })], readAt: READ };
    await act(async () => {
      StubEventSource.last?.send({ type: "entry.changed", artifactId: "artifact-1" });
    });
    expect(server.loads).toBe(1);
    expect(bell().hasAttribute("data-dot")).toBe(false);

    await act(async () => {
      StubEventSource.last?.send({
        type: "entry.changed",
        artifactId: "artifact-1",
        activity: true,
      });
    });
    await waitFor(() => expect(bell().hasAttribute("data-dot")).toBe(true));
    expect(server.loads).toBe(2);
  });
});

describe("list", () => {
  test("says what happened, newest first, and keeps what was new marked while open", async () => {
    stubServer({
      items: [
        item({ id: "a", kind: "status.changed", change: "solved" }),
        item({ id: "b", kind: "status.changed", change: "archived" }),
        item({ id: "c", kind: "comment.created", reply: true }),
        item({ id: "d", kind: "comment.created", reply: false }),
        item({ id: "e", kind: "version.created", versionNumber: 3 }),
        item({ id: "f", kind: "entry.changed", key: "note:P-01" }),
        item({ id: "g", kind: "artifact.created", createdAt: EARLIER }),
      ],
      readAt: READ,
    });
    renderBell();
    await userEvent.click(await screen.findByRole("button", { name: "Notifications, unread" }));

    const rows = within(screen.getByRole("dialog", { name: "Notifications" })).getAllByRole(
      "listitem",
    );
    expect(rows.map((row) => row.querySelector("span")?.textContent)).toEqual([
      "B Person marked Plan solved",
      "B Person archived Plan",
      "B Person replied on Plan",
      "B Person commented on Plan",
      "B Person uploaded version 3 of Plan",
      "B Person wrote note:P-01 on Plan",
      "B Person uploaded Plan",
    ]);
    expect(rows.map((row) => row.hasAttribute("data-unread"))).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
  });

  test("links the actor's name to their profile, apart from the row that opens the artifact", async () => {
    stubServer({ items: [item({ id: "c", kind: "comment.created", reply: false })], readAt: READ });
    const opened: string[] = [];
    renderBell((id) => opened.push(id));
    await userEvent.click(await screen.findByRole("button", { name: "Notifications, unread" }));

    const name = screen.getByRole("link", { name: "B Person" });
    expect(name.getAttribute("href")).toBe("/u/user-2");
    // A link inside the row's button would be invalid markup and unreachable by keyboard.
    expect(name.closest("button")).toBeNull();
    expect(screen.getByRole("button", { name: "B Person commented on Plan" })).toBeDefined();

    await userEvent.click(name);
    expect(window.location.pathname).toBe("/u/user-2");
    expect(opened).toEqual([]);
    expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull();
    window.history.replaceState(null, "", "/");
  });

  test("opening it clears the dot and tells the server", async () => {
    const server = stubServer({ items: [item({ kind: "artifact.created" })], readAt: READ });
    renderBell();

    await userEvent.click(await screen.findByRole("button", { name: "Notifications, unread" }));

    await waitFor(() => expect(bell().hasAttribute("data-dot")).toBe(false));
    expect(server.reads).toBe(1);
  });

  test("keeps the dot when the server could not record the opening", async () => {
    const server = stubServer(
      { items: [item({ kind: "artifact.created" })], readAt: READ },
      { failRead: true },
    );
    renderBell();

    await userEvent.click(await screen.findByRole("button", { name: "Notifications, unread" }));
    await act(async () => {});

    expect(server.reads).toBe(1);
    expect(bell().hasAttribute("data-dot")).toBe(true);
  });

  test("does not let a reload that started before the opening bring the dot back", async () => {
    const server = stubServer({ items: [item({ kind: "artifact.created" })], readAt: READ });
    renderBell();
    await screen.findByRole("button", { name: "Notifications, unread" });

    // This reload leaves with the old marker and answers after the opening.
    server.hold = true;
    const stale = server.feed;
    await announce();
    await userEvent.click(bell());
    await waitFor(() => expect(bell().hasAttribute("data-dot")).toBe(false));

    server.feed = stale;
    await act(async () => server.held?.());

    expect(bell().hasAttribute("data-dot")).toBe(false);
  });

  test("does not tell the server when there was nothing new", async () => {
    const server = stubServer({ items: [], readAt: READ });
    renderBell();
    await act(async () => {});

    await userEvent.click(bell());

    expect(await screen.findByText("Nothing you watch changed in the last 7 days.")).toBeDefined();
    expect(server.reads).toBe(0);
  });

  test("opens the comment a comment entry is about, and closes", async () => {
    stubServer({ items: [item({ kind: "comment.created", reply: false })], readAt: READ });
    const opened: unknown[] = [];
    renderBell((id, target) => opened.push([id, target]));

    await userEvent.click(await screen.findByRole("button", { name: "Notifications, unread" }));
    await userEvent.click(screen.getByRole("button", { name: /commented on Plan/ }));

    expect(opened).toEqual([["artifact-1", { commentId: "item-1" }]]);
    expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull();
  });

  test("opens the version a new-version entry is about", async () => {
    stubServer({
      items: [item({ id: "version-3", kind: "version.created", versionNumber: 3 })],
      readAt: READ,
    });
    const opened: unknown[] = [];
    renderBell((id, target) => opened.push([id, target]));

    await userEvent.click(await screen.findByRole("button", { name: "Notifications, unread" }));
    await userEvent.click(screen.getByRole("button", { name: /uploaded version 3/ }));

    expect(opened).toEqual([["artifact-1", { versionId: "version-3" }]]);
  });

  test("opens just the artifact for a new artifact or a status change", async () => {
    stubServer({
      items: [
        item({ id: "a", kind: "status.changed", change: "solved" }),
        item({ id: "b", kind: "artifact.created" }),
      ],
      readAt: READ,
    });
    const opened: unknown[] = [];
    renderBell((id, target) => opened.push([id, target]));

    await userEvent.click(await screen.findByRole("button", { name: "Notifications, unread" }));
    await userEvent.click(screen.getByRole("button", { name: /marked Plan solved/ }));
    await userEvent.click(bell());
    await userEvent.click(screen.getByRole("button", { name: /uploaded Plan/ }));

    expect(opened).toEqual([
      ["artifact-1", undefined],
      ["artifact-1", undefined],
    ]);
  });

  test("closes on Escape and gives focus back to the bell", async () => {
    stubServer({ items: [], readAt: READ });
    renderBell();
    await act(async () => {});
    await userEvent.click(bell());
    expect(screen.getByRole("dialog", { name: "Notifications" })).toBeDefined();

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull();
    expect(document.activeElement).toBe(bell());
  });
});

describe("watching", () => {
  /** Serves both lists and records every subscription change. */
  function stubLists(watching: ActivityItem[], everyone: ActivityItem[]) {
    const server = { changes: [] as [string, unknown][], loads: [] as string[] };
    stubFetchWith((path, init) => {
      if (init?.method === "PUT") {
        server.changes.push([path, JSON.parse(String(init.body))]);
        return Promise.resolve(
          json({ subscription: { level: "none", reason: null, inherited: null } }),
        );
      }
      server.loads.push(path);
      const items = path.includes("scope=everyone") ? everyone : watching;
      return Promise.resolve(json({ items, readAt: READ }));
    });
    return server;
  }

  test("lists everything visible under Everyone, without lighting the dot for it", async () => {
    const unwatched = item({ id: "item-2", kind: "artifact.created", reason: null });
    const server = stubLists([], [unwatched]);
    renderBell();
    await act(async () => {});
    expect(bell().hasAttribute("data-dot")).toBe(false);

    await userEvent.click(bell());
    await userEvent.click(screen.getByRole("button", { name: "Everyone" }));

    const row = (await screen.findByText("Not watching")).closest("li") as HTMLElement;
    expect(row.hasAttribute("data-unread")).toBe(false);
    expect(server.loads).toContain("/api/activity?scope=everyone");
    expect(bell().hasAttribute("data-dot")).toBe(false);
  });

  test("says why each item arrived and offers the change that would stop it", async () => {
    const research = { id: "folder-1", name: "Research" };
    const server = stubLists(
      [
        item({ id: "item-1", kind: "artifact.created", reason: { kind: "commented" } }),
        item({
          id: "item-2",
          kind: "comment.created",
          reply: false,
          artifact: { id: "artifact-2", title: "Matrix" },
          reason: { kind: "folder", folder: research },
        }),
      ],
      [],
    );
    renderBell();
    await userEvent.click(await screen.findByRole("button", { name: "Notifications, unread" }));

    expect(screen.getByText("You commented")).toBeDefined();
    expect(screen.getByText("Watching Research")).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "Stop watching Research" }));
    await userEvent.click(screen.getByRole("button", { name: "Stop watching" }));

    expect(server.changes).toEqual([
      ["/api/activity/subscriptions/folders/folder-1", { level: "none" }],
      ["/api/activity/subscriptions/artifacts/artifact-1", { level: "none" }],
    ]);
  });

  test("watches an artifact from the Everyone list", async () => {
    const server = stubLists([], [item({ kind: "artifact.created", reason: null })]);
    renderBell();
    await act(async () => {});
    await userEvent.click(bell());
    await userEvent.click(screen.getByRole("button", { name: "Everyone" }));

    await userEvent.click(await screen.findByRole("button", { name: "Watch" }));

    expect(server.changes).toEqual([
      ["/api/activity/subscriptions/artifacts/artifact-1", { level: "all" }],
    ]);
  });
});
