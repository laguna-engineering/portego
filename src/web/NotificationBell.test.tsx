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
 * Serves `server.feed` and records read requests. A read moves the marker the
 * way the server would. Setting `hold` keeps the next feed response waiting.
 */
function stubServer(feed: ActivityFeed, options: { failRead?: boolean } = {}) {
  const server = {
    feed,
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
        item({ id: "f", kind: "artifact.created", createdAt: EARLIER }),
      ],
      readAt: READ,
    });
    renderBell();
    await userEvent.click(await screen.findByRole("button", { name: "Notifications, unread" }));

    const rows = within(screen.getByRole("dialog", { name: "Notifications" })).getAllByRole(
      "button",
    );
    expect(rows.map((row) => row.querySelector("span")?.textContent)).toEqual([
      "B Person marked Plan solved",
      "B Person archived Plan",
      "B Person replied on Plan",
      "B Person commented on Plan",
      "B Person uploaded version 3 of Plan",
      "B Person uploaded Plan",
    ]);
    expect(rows.map((row) => row.hasAttribute("data-unread"))).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
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

    expect(await screen.findByText("Nothing in the last 7 days.")).toBeDefined();
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
