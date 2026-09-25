import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ArtifactFull } from "./ArtifactFull.tsx";
import type { ArtifactVersion } from "./api.ts";
import { artifact, restoreFetch, StubEventSource, stubFetch } from "./testing.ts";

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

function version(overrides: Partial<ArtifactVersion> = {}): ArtifactVersion {
  return {
    id: "artifact-1",
    number: 1,
    originalFilename: "chart.html",
    sha256: "a".repeat(64),
    byteSize: 2048,
    creator: { id: "user-1", name: "A Person", email: "person@acme.example" },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function answer(path: string) {
  // Query strings (e.g. `?version=`) leave the path itself unchanged.
  const base = path.split("?")[0] ?? path;
  if (base.endsWith("/preview")) return { body: { url: "http://127.0.0.1:5173/preview/token" } };
  if (base.endsWith("/comments")) return { body: { comments: [] } };
  if (base.endsWith("/versions")) return { body: { versions: [version()] } };
  if (base.endsWith("/markdown")) {
    return {
      body: {
        markdown: "# Sales chart\n\nQ3 by region",
        empty: false,
        converterVersion: "1",
        generatedAt: new Date().toISOString(),
      },
    };
  }
  return { body: { artifact: artifact() } };
}

function renderFull() {
  return render(
    <ArtifactFull
      id="artifact-1"
      email="person@acme.example"
      currentUserId="user-1"
      onHome={() => {}}
      onSignOut={() => {}}
    />,
  );
}

/**
 * The preview's document is untrusted and normally talks back over
 * `postMessage`. happy-dom gives every iframe a real `contentWindow`, so
 * stubbing that method lets a test see exactly what the page sent it.
 */
function stubPostMessage(frame: HTMLIFrameElement): unknown[] {
  const sent: unknown[] = [];
  const contentWindow = frame.contentWindow;
  if (!contentWindow) throw new Error("The frame has no window in this environment.");
  contentWindow.postMessage = ((message: unknown) => {
    sent.push(message);
  }) as typeof contentWindow.postMessage;
  return sent;
}

/** Plays the preview's side of the bridge: a message from the frame's window. */
async function sendFromFrame(frame: HTMLIFrameElement, message: Record<string, unknown>) {
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { portego: 1, ...message },
        source: frame.contentWindow as unknown as MessageEventSource,
      }),
    );
  });
}

describe("header", () => {
  test("shows the title, its state, and the metadata a reader needs to trust the artifact", async () => {
    stubFetch((path) =>
      path.endsWith("/api/artifacts/artifact-1")
        ? {
            body: {
              artifact: artifact({ status: "solved", archivedAt: new Date().toISOString() }),
            },
          }
        : answer(path),
    );
    renderFull();

    const heading = await screen.findByRole("heading", { name: /Sales chart/ });
    // The header clips a long title to one line, so hovering shows all of it.
    expect(heading.getAttribute("title")).toBe("Sales chart");
    // Both badges tell the reader the artifact's disposition without opening it.
    expect(screen.getByText("solved")).toBeDefined();
    expect(screen.getByText("archived")).toBeDefined();
    // Scoped to the header: the versions panel (always mounted) also names the
    // creator, size, and time of its own row.
    const meta = within(heading.closest(".full-title") as HTMLElement);
    expect(meta.getByText(/A Person/)).toBeDefined();
    expect(meta.getByText(/2 KiB/)).toBeDefined();
    expect(meta.getByText("chart.html")).toBeDefined();
  });
});

describe("actions", () => {
  test("copies the artifact's link", async () => {
    stubFetch(answer);
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => void copied.push(text) },
    });
    renderFull();

    await userEvent.click(await screen.findByRole("button", { name: "Copy link" }));

    expect(copied).toEqual(["http://localhost:5173/a/artifact-1"]);
    expect(await screen.findByRole("button", { name: "Link copied" })).toBeDefined();
  });

  test("marks an artifact solved and flips the button to the action left to take", async () => {
    const sent: { path: string; method?: string; body?: unknown }[] = [];
    stubFetch((path, init) => {
      if (!path.endsWith("/status")) return answer(path);
      sent.push({ path, method: init?.method, body: JSON.parse(String(init?.body)) });
      return { body: { artifact: artifact({ status: "solved" }) } };
    });
    renderFull();

    await userEvent.click(await screen.findByRole("button", { name: "Mark solved" }));

    expect(await screen.findByText("solved")).toBeDefined();
    expect(screen.getByRole("button", { name: "Reopen" })).toBeDefined();
    expect(sent).toEqual([
      { path: "/api/artifacts/artifact-1/status", method: "PATCH", body: { status: "solved" } },
    ]);
  });

  test("archives an artifact and offers to restore it", async () => {
    const sent: { path: string; method?: string; body?: unknown }[] = [];
    stubFetch((path, init) => {
      if (!path.endsWith("/archived")) return answer(path);
      sent.push({ path, method: init?.method, body: JSON.parse(String(init?.body)) });
      return { body: { artifact: artifact({ archivedAt: new Date().toISOString() }) } };
    });
    renderFull();

    await userEvent.click(await screen.findByRole("button", { name: "Archive" }));

    expect(await screen.findByText("archived")).toBeDefined();
    expect(screen.getByRole("button", { name: "Restore" })).toBeDefined();
    expect(sent).toEqual([
      { path: "/api/artifacts/artifact-1/archived", method: "PATCH", body: { archived: true } },
    ]);
  });

  test("offers the source as a download that keeps the original name", async () => {
    stubFetch(answer);
    renderFull();

    const link = (await screen.findByRole("link", {
      name: "Download source",
    })) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/api/artifacts/artifact-1/source");
    expect(link.getAttribute("download")).toBe("chart.html");
  });

  test("says what the server refused and leaves the artifact shown as it was", async () => {
    stubFetch((path) =>
      path.endsWith("/status")
        ? { status: 403, body: { error: { code: "FORBIDDEN", message: "Not yours to change." } } }
        : answer(path),
    );
    renderFull();

    await userEvent.click(await screen.findByRole("button", { name: "Mark solved" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Not yours to change.");
    // The failed change did not replace the artifact with an error page.
    expect(screen.getByRole("heading", { name: /Sales chart/ })).toBeDefined();
    expect(screen.getByRole("button", { name: "Mark solved" })).toBeDefined();
  });
});

describe("organizing", () => {
  const FOLDERS = [
    { id: "lampo", name: "Lampo", parentId: null, artifactCount: 0 },
    { id: "launch", name: "Launch", parentId: "lampo", artifactCount: 0 },
    { id: "portego", name: "Portego", parentId: null, artifactCount: 0 },
  ];
  const TAGS = [
    { id: "launch", name: "launch", artifactCount: 1 },
    { id: "review", name: "review", artifactCount: 0 },
  ];

  type Sent = { path: string; method?: string; body?: unknown };

  /** Answers the organization API and records every change sent to it. */
  function stubOrganization(start = artifact()) {
    const sent: Sent[] = [];
    let current = start;
    stubFetch((path, init) => {
      if (init?.method && init.method !== "GET") {
        const body = JSON.parse(String(init.body));
        sent.push({ path, method: init.method, body });
        if (path === "/api/folders") {
          return { status: 201, body: { folder: { id: "new", parentId: null, ...body } } };
        }
        if (path === "/api/tags") {
          return { status: 201, body: { tag: { id: "new", artifactCount: 0, ...body } } };
        }
        if (path.endsWith("/organization")) {
          const folder = FOLDERS.find((one) => one.id === body.folderId);
          current = {
            ...current,
            ...("folderId" in body
              ? {
                  folder:
                    folder ??
                    (body.folderId ? { id: body.folderId, name: "New", parentId: null } : null),
                }
              : {}),
            ...("tagIds" in body
              ? { tags: (body.tagIds as string[]).map((id) => ({ id, name: id })) }
              : {}),
          };
          return { body: { artifact: current } };
        }
      }
      if (path === "/api/folders") return { body: { folders: FOLDERS } };
      if (path === "/api/tags") return { body: { tags: TAGS } };
      return path.endsWith("/api/artifacts/artifact-1")
        ? { body: { artifact: current } }
        : answer(path);
    });
    return sent;
  }

  test("lists the folder tree under No folder and marks where the artifact is filed", async () => {
    stubOrganization(artifact({ folder: { id: "launch", name: "Launch", parentId: "lampo" } }));
    renderFull();

    await userEvent.click(await screen.findByRole("button", { name: "Move to folder" }));
    const dialog = await screen.findByRole("dialog", { name: "Move to folder" });
    await within(dialog).findByText("Portego");

    const options = within(dialog)
      .getAllByRole("button")
      .map((button) => button.textContent);
    expect(options).toEqual(["No folder", "Lampo", "Launch", "Portego"]);
    expect(within(dialog).getByRole("button", { name: "Launch", pressed: true })).toBeDefined();
  });

  test("files the artifact in the chosen folder, closes, and gives focus back to the button", async () => {
    const sent = stubOrganization();
    renderFull();

    const opener = await screen.findByRole("button", { name: "Move to folder" });
    await userEvent.click(opener);
    await userEvent.click(await screen.findByRole("button", { name: "Portego" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Move to folder" })).toBeNull(),
    );
    expect(document.activeElement).toBe(opener);
    expect(sent).toEqual([
      {
        path: "/api/artifacts/artifact-1/organization",
        method: "PATCH",
        body: { folderId: "portego" },
      },
    ]);
  });

  test("shows each match's parents while searching, so two folders with one name can be told apart", async () => {
    stubOrganization();
    renderFull();

    await userEvent.click(await screen.findByRole("button", { name: "Move to folder" }));
    await userEvent.type(await screen.findByRole("searchbox"), "laun");

    expect(await screen.findByRole("button", { name: "Lampo › Launch" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Portego" })).toBeNull();
  });

  test("creates a folder from a new name and files the artifact in it", async () => {
    const sent = stubOrganization();
    renderFull();

    await userEvent.click(await screen.findByRole("button", { name: "Move to folder" }));
    const search = await screen.findByRole("searchbox");
    await screen.findByRole("button", { name: "Portego" });
    await userEvent.type(search, "Events{Enter}");

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Move to folder" })).toBeNull(),
    );
    expect(sent).toEqual([
      { path: "/api/folders", method: "POST", body: { name: "Events" } },
      {
        path: "/api/artifacts/artifact-1/organization",
        method: "PATCH",
        body: { folderId: "new" },
      },
    ]);
  });

  test("does not offer to create a folder that already exists at the top level", async () => {
    stubOrganization();
    renderFull();

    await userEvent.click(await screen.findByRole("button", { name: "Move to folder" }));
    await screen.findByRole("button", { name: "Portego" });
    await userEvent.type(screen.getByRole("searchbox"), "portego");

    expect(screen.queryByRole("button", { name: /Create/ })).toBeNull();
  });

  test("adds and removes tags as a whole set and stays open for the next one", async () => {
    const sent = stubOrganization(artifact({ tags: [{ id: "launch", name: "launch" }] }));
    renderFull();

    await userEvent.click(await screen.findByRole("button", { name: "Tags" }));
    const dialog = await screen.findByRole("dialog", { name: "Tags" });
    await userEvent.click(await within(dialog).findByRole("button", { name: "review" }));
    await within(dialog).findByRole("button", { name: "review", pressed: true });
    await userEvent.click(within(dialog).getByRole("button", { name: "launch", pressed: true }));
    await within(dialog).findByRole("button", { name: "launch", pressed: false });

    expect(screen.getByRole("dialog", { name: "Tags" })).toBeDefined();
    expect(sent.map((one) => one.body)).toEqual([
      { tagIds: ["launch", "review"] },
      { tagIds: ["review"] },
    ]);
  });

  test("marks the Tags button while the artifact has at least one tag", async () => {
    stubOrganization(artifact({ tags: [{ id: "launch", name: "launch" }] }));
    renderFull();

    const opener = await screen.findByRole("button", { name: "Tags" });
    expect(opener.hasAttribute("data-dot")).toBe(true);

    await userEvent.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "Tags" });
    await userEvent.click(
      await within(dialog).findByRole("button", { name: "launch", pressed: true }),
    );
    await within(dialog).findByRole("button", { name: "launch", pressed: false });

    expect(opener.hasAttribute("data-dot")).toBe(false);
  });

  test("creates a tag from a new name and applies it", async () => {
    const sent = stubOrganization();
    renderFull();

    await userEvent.click(await screen.findByRole("button", { name: "Tags" }));
    await screen.findByRole("button", { name: "review" });
    await userEvent.type(screen.getByRole("searchbox"), "metrics{Enter}");

    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent).toEqual([
      { path: "/api/tags", method: "POST", body: { name: "metrics" } },
      {
        path: "/api/artifacts/artifact-1/organization",
        method: "PATCH",
        body: { tagIds: ["new"] },
      },
    ]);
  });

  test("closes on Escape without changing anything", async () => {
    const sent = stubOrganization();
    renderFull();

    await userEvent.click(await screen.findByRole("button", { name: "Tags" }));
    await screen.findByRole("dialog", { name: "Tags" });
    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("dialog", { name: "Tags" })).toBeNull();
    expect(sent).toEqual([]);
  });

  test("says what the server refused inside the panel", async () => {
    stubFetch((path, init) => {
      if (path.endsWith("/organization") && init?.method === "PATCH") {
        return {
          status: 400,
          body: { error: { code: "INVALID_INPUT", message: "An artifact can have 20 tags." } },
        };
      }
      if (path === "/api/tags") return { body: { tags: TAGS } };
      return answer(path);
    });
    renderFull();

    await userEvent.click(await screen.findByRole("button", { name: "Tags" }));
    await userEvent.click(await screen.findByRole("button", { name: "review" }));

    const dialog = screen.getByRole("dialog", { name: "Tags" });
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "An artifact can have 20 tags.",
    );
  });
});

describe("views", () => {
  test("swaps the preview for the markdown text and back", async () => {
    stubFetch(answer);
    renderFull();

    await screen.findByTitle("Preview of Sales chart");
    const toggle = screen.getByRole("button", { name: "View markdown" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");

    await userEvent.click(toggle);

    expect(await screen.findByText(/# Sales chart/)).toBeDefined();
    expect(screen.queryByTitle("Preview of Sales chart")).toBeNull();
    const back = screen.getByRole("button", { name: "View preview" });
    expect(back.getAttribute("aria-pressed")).toBe("true");

    await userEvent.click(back);

    expect(await screen.findByTitle("Preview of Sales chart")).toBeDefined();
    expect(screen.queryByText(/# Sales chart/)).toBeNull();
  });
});

describe("comments panel", () => {
  test("opens the panel and turns comment mode on in the frame", async () => {
    stubFetch(answer);
    renderFull();
    const frame = (await screen.findByTitle("Preview of Sales chart")) as HTMLIFrameElement;
    const sent = stubPostMessage(frame);

    const toggle = await screen.findByRole("button", { name: "Versions & comments" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    await userEvent.click(toggle);

    expect(await screen.findByRole("dialog", { name: "Versions and comments" })).toBeDefined();
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    // Selection only matters in the artifact while a reader can act on it.
    expect(sent).toContainEqual({ portego: 1, type: "mode", enabled: true });
  });

  test("shows a passage selected in the artifact and posts it as the comment's anchor", async () => {
    const posted: unknown[] = [];
    stubFetch((path, init) => {
      if (path.endsWith("/comments") && init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)));
        return {
          status: 201,
          body: {
            comment: {
              id: "comment-2",
              body: "Nice",
              createdAt: new Date().toISOString(),
              author: { id: "user-1", name: "A Person", email: "person@acme.example" },
              anchor: null,
              parentId: null,
            },
          },
        };
      }
      return answer(path);
    });
    renderFull();
    const frame = (await screen.findByTitle("Preview of Sales chart")) as HTMLIFrameElement;
    await userEvent.click(await screen.findByRole("button", { name: "Versions & comments" }));

    await sendFromFrame(frame, {
      type: "selection",
      anchor: { quote: "important line", prefix: "before ", suffix: " after" },
    });

    expect(await screen.findByText("important line")).toBeDefined();

    await userEvent.type(screen.getByLabelText("Add a comment"), "Nice");
    await userEvent.click(screen.getByRole("button", { name: "Comment" }));

    // The anchor travels with the comment, not as a separate request, and it
    // carries the version being viewed (here, the current one).
    expect(posted).toEqual([
      {
        body: "Nice",
        anchor: { quote: "important line", prefix: "before ", suffix: " after" },
        versionId: "artifact-1",
      },
    ]);
  });

  test("drops the pending selection once the panel is closed", async () => {
    stubFetch(answer);
    renderFull();
    const frame = (await screen.findByTitle("Preview of Sales chart")) as HTMLIFrameElement;
    const toggle = await screen.findByRole("button", { name: "Versions & comments" });
    await userEvent.click(toggle);
    await sendFromFrame(frame, {
      type: "selection",
      anchor: { quote: "a line", prefix: "", suffix: "" },
    });
    expect(await screen.findByText("a line")).toBeDefined();

    await userEvent.click(toggle);

    expect(screen.queryByText("a line")).toBeNull();
  });

  test("reveals a comment's quote in the artifact when it is clicked", async () => {
    stubFetch((path) =>
      path.endsWith("/comments")
        ? {
            body: {
              comments: [
                {
                  id: "comment-1",
                  body: "See this",
                  createdAt: new Date().toISOString(),
                  author: { id: "user-2", name: "Someone", email: "s@x.test" },
                  anchor: { quote: "the highlighted bit", prefix: "", suffix: "" },
                  parentId: null,
                },
              ],
            },
          }
        : answer(path),
    );
    renderFull();
    const frame = (await screen.findByTitle("Preview of Sales chart")) as HTMLIFrameElement;
    const sent = stubPostMessage(frame);
    await userEvent.click(await screen.findByRole("button", { name: "Versions & comments" }));

    await userEvent.click(await screen.findByText("the highlighted bit"));

    expect(sent).toContainEqual({ portego: 1, type: "reveal", id: "comment-1" });
  });

  test("opens the panel and highlights the comment the artifact reports focusing", async () => {
    stubFetch((path) =>
      path.endsWith("/comments")
        ? {
            body: {
              comments: [
                {
                  id: "comment-1",
                  body: "See this",
                  createdAt: new Date().toISOString(),
                  author: { id: "user-2", name: "Someone", email: "s@x.test" },
                  anchor: { quote: "the highlighted bit", prefix: "", suffix: "" },
                  parentId: null,
                },
              ],
            },
          }
        : answer(path),
    );
    renderFull();
    const frame = (await screen.findByTitle("Preview of Sales chart")) as HTMLIFrameElement;
    await screen.findByText("the highlighted bit");

    await sendFromFrame(frame, { type: "focus", id: "comment-1" });

    expect(await screen.findByRole("dialog", { name: "Versions and comments" })).toBeDefined();
    expect(document.getElementById("comment-comment-1")?.className).toContain("focused");
  });
});

describe("selection overlay", () => {
  test("offers to comment on a selection made while the panel is closed", async () => {
    stubFetch(answer);
    renderFull();
    const frame = (await screen.findByTitle("Preview of Sales chart")) as HTMLIFrameElement;

    await sendFromFrame(frame, {
      type: "selection",
      anchor: { quote: "important line", prefix: "before ", suffix: " after" },
      rect: { top: 10, left: 10, right: 20, bottom: 20 },
    });

    await userEvent.click(await screen.findByRole("button", { name: "Comment on selection" }));

    expect(await screen.findByRole("dialog", { name: "Versions and comments" })).toBeDefined();
    expect(await screen.findByText("important line")).toBeDefined();
    // The overlay's job is done once its selection has moved into the composer.
    expect(screen.queryByRole("button", { name: "Comment on selection" })).toBeNull();
  });

  test("removes the overlay once the artifact reports the selection cleared", async () => {
    stubFetch(answer);
    renderFull();
    const frame = (await screen.findByTitle("Preview of Sales chart")) as HTMLIFrameElement;
    await sendFromFrame(frame, {
      type: "selection",
      anchor: { quote: "a line", prefix: "", suffix: "" },
      rect: { top: 10, left: 10, right: 20, bottom: 20 },
    });
    await screen.findByRole("button", { name: "Comment on selection" });

    await sendFromFrame(frame, { type: "selection", anchor: null });

    expect(screen.queryByRole("button", { name: "Comment on selection" })).toBeNull();
  });

  test("still fills the composer from a selection without a rect while the panel is open", async () => {
    stubFetch(answer);
    renderFull();
    const frame = (await screen.findByTitle("Preview of Sales chart")) as HTMLIFrameElement;
    await userEvent.click(await screen.findByRole("button", { name: "Versions & comments" }));

    await sendFromFrame(frame, {
      type: "selection",
      anchor: { quote: "no rect line", prefix: "", suffix: "" },
    });

    expect(await screen.findByText("no rect line")).toBeDefined();
    // Without a rect there is nowhere on screen to anchor the overlay button.
    expect(screen.queryByRole("button", { name: "Comment on selection" })).toBeNull();
  });
});

describe("live updates", () => {
  test("reloads the artifact when the stream announces a change to it", async () => {
    let current = artifact();
    stubFetch((path) => {
      const base = path.split("?")[0] ?? path;
      return base.endsWith("/artifact-1") ? { body: { artifact: current } } : answer(path);
    });
    renderFull();
    expect(await screen.findByRole("button", { name: "Mark solved" })).toBeDefined();

    current = artifact({ status: "solved" });
    await announce({ type: "artifact.changed", id: "artifact-1" });

    expect(await screen.findByRole("button", { name: "Reopen" })).toBeDefined();
    expect(screen.getByText("solved")).toBeDefined();
  });

  test("ignores a change to some other artifact", async () => {
    let calls = 0;
    stubFetch((path) => {
      if (!path.endsWith("/preview") && !path.endsWith("/markdown")) calls += 1;
      return answer(path);
    });
    renderFull();
    await screen.findByRole("heading", { name: /Sales chart/ });
    const before = calls;

    await announce({ type: "artifact.changed", id: "artifact-2" });

    await waitFor(() => expect(calls).toBe(before));
  });
});

describe("versions", () => {
  const twoVersions = [version({ id: "v2", number: 2 }), version({ id: "v1", number: 1 })];

  function stubTwoVersions(
    extra?: (path: string, init?: RequestInit) => { status?: number; body?: unknown } | null,
  ) {
    stubFetch((path, init) => {
      const overridden = extra?.(path, init);
      if (overridden) return overridden;
      const base = path.split("?")[0] ?? path;
      if (base.endsWith("/versions")) return { body: { versions: twoVersions } };
      if (base.endsWith("/artifact-1")) {
        return { body: { artifact: artifact({ currentVersionId: "v2" }) } };
      }
      return answer(path);
    });
  }

  test("shows a row per version, highest first, and marks the current one", async () => {
    stubTwoVersions();
    renderFull();

    await userEvent.click(await screen.findByRole("button", { name: "Versions & comments" }));

    const rows = await screen.findAllByRole("button", { name: /^Version \d/ });
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
      "Version 2, current",
      "Version 1",
    ]);
    // Nothing has been picked yet, so the current version is the one selected.
    expect(rows[0]?.getAttribute("aria-pressed")).toBe("true");
    expect(rows[1]?.getAttribute("aria-pressed")).toBe("false");
  });

  test("clicking a version switches the preview, markdown, and source requests to that version", async () => {
    const requested: string[] = [];
    stubTwoVersions((path) => {
      const base = path.split("?")[0] ?? path;
      if (base.endsWith("/preview") || base.endsWith("/markdown")) requested.push(path);
      return null;
    });
    renderFull();
    await screen.findByTitle("Preview of Sales chart");
    await userEvent.click(await screen.findByRole("button", { name: "Versions & comments" }));
    requested.length = 0;

    await userEvent.click(await screen.findByRole("button", { name: "Version 1" }));

    await waitFor(() => expect(requested.some((path) => path.includes("version=v1"))).toBe(true));
    const link = screen.getByRole("link", { name: "Download source" }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/api/artifacts/artifact-1/source?version=v1");

    requested.length = 0;
    await userEvent.click(screen.getByRole("button", { name: "View markdown" }));

    await waitFor(() =>
      expect(requested.some((path) => path.includes("/markdown?version=v1"))).toBe(true),
    );
  });

  test("highlights a comment written on an older version while viewing the current one", async () => {
    stubTwoVersions((path) =>
      path.endsWith("/comments")
        ? {
            body: {
              comments: [
                {
                  id: "comment-1",
                  body: "Still true",
                  createdAt: new Date().toISOString(),
                  author: { id: "user-2", name: "Someone", email: "s@x.test" },
                  anchor: { quote: "the highlighted bit", prefix: "", suffix: "" },
                  parentId: null,
                  versionId: "v1",
                  versionNumber: 1,
                },
              ],
            },
          }
        : null,
    );
    renderFull();
    const frame = (await screen.findByTitle("Preview of Sales chart")) as HTMLIFrameElement;
    const sent = stubPostMessage(frame);
    await screen.findByText("the highlighted bit");

    await sendFromFrame(frame, { type: "ready" });

    expect(sent).toContainEqual({
      portego: 1,
      type: "highlights",
      anchors: [{ id: "comment-1", quote: "the highlighted bit", prefix: "", suffix: "" }],
    });
  });

  test("keeps a single version's row, showing it as the current one", async () => {
    stubFetch(answer);
    renderFull();

    await userEvent.click(await screen.findByRole("button", { name: "Versions & comments" }));

    const rows = await screen.findAllByRole("button", { name: /^Version \d/ });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.getAttribute("aria-label")).toBe("Version 1, current");
  });

  test("reloads the version list when the stream announces a change", async () => {
    let listed = [version({ id: "v1", number: 1 })];
    let currentVersionId = "v1";
    stubFetch((path) => {
      const base = path.split("?")[0] ?? path;
      if (base.endsWith("/versions")) return { body: { versions: listed } };
      if (base.endsWith("/artifact-1"))
        return { body: { artifact: artifact({ currentVersionId }) } };
      return answer(path);
    });
    renderFull();
    await userEvent.click(await screen.findByRole("button", { name: "Versions & comments" }));
    await screen.findByRole("button", { name: "Version 1, current" });

    listed = [version({ id: "v2", number: 2 }), version({ id: "v1", number: 1 })];
    currentVersionId = "v2";
    await announce({ type: "artifact.changed", id: "artifact-1" });

    expect(await screen.findByRole("button", { name: "Version 2, current" })).toBeDefined();
  });
});
