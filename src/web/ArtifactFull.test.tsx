import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ArtifactFull, type ArtifactFullProps } from "./ArtifactFull.tsx";
import type { ArtifactVersion, Comment } from "./api.ts";
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

function version(overrides: Partial<ArtifactVersion> = {}): ArtifactVersion {
  return {
    id: "artifact-1",
    number: 1,
    originalFilename: "chart.html",
    sha256: "a".repeat(64),
    byteSize: 2048,
    creator: { id: "user-1", name: "A Person", email: "person@acme.example" },
    createdAt: new Date().toISOString(),
    inApp: false,
    ...overrides,
  };
}

function answer(path: string) {
  // Query strings (e.g. `?version=`) leave the path itself unchanged.
  const base = path.split("?")[0] ?? path;
  if (base === "/api/activity") return { body: { items: [], readAt: null } };
  if (base.startsWith("/api/activity/subscriptions/")) {
    return { body: { subscription: { level: null, reason: null, inherited: null } } };
  }
  if (base.endsWith("/preview")) return { body: { url: "http://127.0.0.1:5173/preview/token" } };
  if (base.endsWith("/comments")) return { body: { comments: [] } };
  if (base.endsWith("/entries")) return { body: { entries: [], schema: null } };
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

function fullProps(overrides: Partial<ArtifactFullProps> = {}): ArtifactFullProps {
  return {
    id: "artifact-1",
    email: "person@acme.example",
    avatar: null,
    currentUserId: "user-1",
    privateArtifacts: true,
    onHome: () => {},
    onOpenFolder: () => {},
    onOpenGallery: () => {},
    onProfile: () => {},
    onOpenArtifact: () => {},
    ...overrides,
  };
}

function renderFull(overrides: Partial<ArtifactFullProps> = {}) {
  return render(<ArtifactFull {...fullProps(overrides)} />);
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

  test("goes back to the artifact's folder in one click", async () => {
    stubFetch((path) =>
      path.endsWith("/api/artifacts/artifact-1")
        ? {
            body: {
              artifact: artifact({ folder: { id: "launch", name: "Launch", parentId: "lampo" } }),
            },
          }
        : answer(path),
    );
    const opened: string[] = [];
    renderFull({ onOpenFolder: (folderId) => opened.push(folderId) });

    await userEvent.click(await screen.findByRole("button", { name: "Open folder Launch" }));
    expect(opened).toEqual(["launch"]);
  });

  test("shows no folder link for an unfiled artifact, which has no folder to go back to", async () => {
    stubFetch(answer);
    renderFull();

    await screen.findByRole("heading", { name: /Sales chart/ });
    expect(screen.queryByRole("button", { name: /^Open folder/ })).toBeNull();
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

  test("lets the creator make the artifact private and share it again", async () => {
    const sent: unknown[] = [];
    stubFetch((path, init) => {
      if (!path.endsWith("/visibility")) return answer(path);
      const body = JSON.parse(String(init?.body)) as { visibility: "shared" | "private" };
      sent.push(body);
      return { body: { artifact: artifact({ visibility: body.visibility }) } };
    });
    renderFull();

    await userEvent.click(await screen.findByRole("button", { name: "Make private" }));
    expect(await screen.findByText("private")).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "Share with everyone" }));
    expect(await screen.findByRole("button", { name: "Make private" })).toBeDefined();
    expect(sent).toEqual([{ visibility: "private" }, { visibility: "shared" }]);
  });

  test("does not offer to change visibility to anyone but the creator", async () => {
    stubFetch(answer);
    renderFull({ currentUserId: "user-2" });

    await screen.findByRole("button", { name: "Mark solved" });
    expect(screen.queryByRole("button", { name: "Make private" })).toBeNull();
  });

  test("does not offer privacy on a deployment that turned private artifacts off", async () => {
    stubFetch(answer);
    renderFull({ privateArtifacts: false });

    await screen.findByRole("button", { name: "Mark solved" });
    expect(screen.queryByRole("button", { name: "Make private" })).toBeNull();
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

describe("someone else's private artifact", () => {
  const PRIVATE = {
    status: 403,
    body: { error: { code: "PRIVATE", message: "This artifact is private." } },
  };

  test("says the artifact is private and nothing else about it", async () => {
    stubFetch((path) => (path === "/api/artifacts/artifact-1" ? PRIVATE : answer(path)));
    renderFull({ currentUserId: "user-2" });

    expect(await screen.findByText("This artifact is private.")).toBeDefined();
    expect(screen.getByRole("button", { name: "Back to the gallery" })).toBeDefined();
    expect(screen.queryByRole("heading")).toBeNull();
    expect(document.body.textContent).not.toContain("A Person");
  });

  test("hides an open artifact once its creator makes it private", async () => {
    let hidden = false;
    stubFetch((path) => (hidden && path === "/api/artifacts/artifact-1" ? PRIVATE : answer(path)));
    renderFull({ currentUserId: "user-2" });
    await screen.findByRole("heading", { name: /Sales chart/ });

    hidden = true;
    await announce({ type: "artifact.changed", id: "artifact-1" });

    expect(await screen.findByText("This artifact is private.")).toBeDefined();
    expect(screen.queryByRole("heading", { name: /Sales chart/ })).toBeNull();
  });
});

describe("watching", () => {
  test("shows a level inherited from a folder, and sets the artifact's own", async () => {
    const sent: unknown[] = [];
    const research = { id: "research", name: "Research" };
    stubFetch((path, init) => {
      if (path === "/api/activity/subscriptions/artifacts/artifact-1") {
        if (init?.method === "PUT") {
          const body = JSON.parse(String(init.body));
          sent.push(body);
          return {
            body: {
              subscription: {
                level: body.level,
                reason: "chosen",
                inherited: { folder: research, level: "versions" },
              },
            },
          };
        }
        return {
          body: {
            subscription: {
              level: null,
              reason: null,
              inherited: { folder: research, level: "versions" },
            },
          },
        };
      }
      return answer(path);
    });
    renderFull();

    await userEvent.click(await screen.findByRole("button", { name: "Watching versions" }));
    const dialog = screen.getByRole("dialog", { name: "Watch" });
    expect(within(dialog).getByRole("button", { pressed: true }).textContent).toContain(
      "New versions only",
    );
    expect(within(dialog).getByText("Set by the Research folder.")).toBeDefined();

    await userEvent.click(within(dialog).getByRole("button", { name: /^All activity/ }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Watch" })).toBeNull());
    expect(sent).toEqual([{ level: "all" }]);
    expect(screen.getByRole("button", { name: "Watching" })).toBeDefined();
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

describe("links to a match in the text", () => {
  test("open the search on the artifact and find the match once the artifact is listening", async () => {
    stubFetch(answer);
    let shown = 0;
    renderFull({
      find: "rollback",
      onLinkShown: () => {
        shown += 1;
      },
    });
    const frame = (await screen.findByTitle("Preview of Sales chart")) as HTMLIFrameElement;
    const sent = stubPostMessage(frame);
    expect(shown).toBe(1);
    // The frame drops a find it gets before it is ready, so none is sent yet.
    expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull();

    await sendFromFrame(frame, { type: "ready" });
    const field = (await screen.findByLabelText("Search everything")) as HTMLInputElement;
    expect(field.value).toBe("rollback");
    await waitFor(() =>
      expect(sent).toContainEqual({ portego: 1, type: "find", query: "rollback", index: 0 }),
    );
  });
});

describe("links to a comment", () => {
  const REVEAL = { portego: 1, type: "reveal", id: "comment-1" };

  function stubAnchoredComment() {
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
                  inApp: true,
                },
              ],
            },
          }
        : answer(path),
    );
  }

  test("opens the panel on the comment, and reveals it once the artifact is listening", async () => {
    stubAnchoredComment();
    let shown = 0;
    renderFull({
      commentId: "comment-1",
      onLinkShown: () => {
        shown += 1;
      },
    });
    const frame = (await screen.findByTitle("Preview of Sales chart")) as HTMLIFrameElement;
    const sent = stubPostMessage(frame);
    await screen.findByText("the highlighted bit");

    expect(
      screen.getByRole("button", { name: "Versions & comments" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(document.getElementById("comment-comment-1")?.className).toContain("focused");
    expect(shown).toBe(1);
    expect(sent).not.toContainEqual(REVEAL);

    await sendFromFrame(frame, { type: "ready" });
    expect(sent).toContainEqual(REVEAL);

    // Revealed once: the artifact reloading later does not jump back to it.
    sent.length = 0;
    await sendFromFrame(frame, { type: "ready" });
    expect(sent).not.toContainEqual(REVEAL);

    // Nor does a later change to the comments reopen what the reader closed.
    await userEvent.click(screen.getByRole("button", { name: "Close comments" }));
    await announce({ type: "comment.changed", artifactId: "artifact-1" });
    expect(
      screen.getByRole("button", { name: "Versions & comments" }).getAttribute("aria-pressed"),
    ).toBe("false");
    expect(sent).not.toContainEqual(REVEAL);
    expect(shown).toBe(1);
  });

  test("waits for the comments when the artifact is listening before they arrive", async () => {
    let releaseComments = () => {};
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    stubFetchWith((path) => {
      if (!path.endsWith("/comments")) return Promise.resolve(json(answer(path).body));
      return new Promise((resolve) => {
        releaseComments = () =>
          resolve(
            json({
              comments: [
                {
                  id: "comment-1",
                  body: "See this",
                  createdAt: new Date().toISOString(),
                  author: { id: "user-2", name: "Someone", email: "s@x.test" },
                  anchor: { quote: "the highlighted bit", prefix: "", suffix: "" },
                  parentId: null,
                  inApp: true,
                },
              ],
            }),
          );
      });
    });
    renderFull({ commentId: "comment-1" });
    const frame = (await screen.findByTitle("Preview of Sales chart")) as HTMLIFrameElement;
    const sent = stubPostMessage(frame);

    await sendFromFrame(frame, { type: "ready" });
    expect(sent).not.toContainEqual(REVEAL);

    await act(async () => releaseComments());
    await screen.findByText("the highlighted bit");

    const reveal = sent.findIndex((message) => JSON.stringify(message) === JSON.stringify(REVEAL));
    const lastHighlights = sent.findLastIndex(
      (message) => (message as { type?: string }).type === "highlights",
    );
    expect(reveal).toBeGreaterThan(lastHighlights);
  });

  test("reveals the comment at once when the artifact is already showing", async () => {
    stubAnchoredComment();
    const { rerender } = renderFull();
    const frame = (await screen.findByTitle("Preview of Sales chart")) as HTMLIFrameElement;
    const sent = stubPostMessage(frame);
    await screen.findByText("the highlighted bit");
    await sendFromFrame(frame, { type: "ready" });
    expect(sent).not.toContainEqual(REVEAL);

    await act(async () => {
      rerender(<ArtifactFull {...fullProps({ commentId: "comment-1" })} />);
    });

    expect(sent).toContainEqual(REVEAL);
  });
});

describe("links in the artifact", () => {
  test("opens a link the artifact passes up in a new tab that cannot reach this one", async () => {
    stubFetch(answer);
    const opened: unknown[][] = [];
    const original = window.open;
    window.open = ((...args: unknown[]) => {
      opened.push(args);
      return null;
    }) as typeof window.open;
    try {
      renderFull();
      const frame = (await screen.findByTitle("Preview of Sales chart")) as HTMLIFrameElement;

      await sendFromFrame(frame, { type: "open", url: "https://example.com/" });

      expect(opened).toEqual([["https://example.com/", "_blank", "noopener,noreferrer"]]);
    } finally {
      window.open = original;
    }
  });
});

describe("links to a part of the artifact", () => {
  const start = window.location.href;
  afterEach(() => window.history.replaceState(null, "", start));

  test("opens the preview on the part the address names", async () => {
    window.history.replaceState(null, "", "/a/artifact-1#item-42");
    stubFetch(answer);
    renderFull();

    const frame = (await screen.findByTitle("Preview of Sales chart")) as HTMLIFrameElement;

    expect(frame.getAttribute("src")).toBe("http://127.0.0.1:5173/preview/token#item-42");
  });

  test("puts the part the reader followed in the address and the copied link", async () => {
    stubFetch(answer);
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => void copied.push(text) },
    });
    renderFull();
    const frame = (await screen.findByTitle("Preview of Sales chart")) as HTMLIFrameElement;
    const historyLength = window.history.length;

    await sendFromFrame(frame, { type: "hash", hash: "#item-42" });
    await userEvent.click(screen.getByRole("button", { name: "Copy link" }));

    expect(window.location.hash).toBe("#item-42");
    // The frame's navigation already added a history entry; another would
    // make Back take two presses.
    expect(window.history.length).toBe(historyLength);
    expect(copied).toEqual(["http://localhost:5173/a/artifact-1#item-42"]);
    // The frame already shows that part, so it is not reloaded with it.
    expect(frame.getAttribute("src")).toBe("http://127.0.0.1:5173/preview/token");
  });
});

describe("entries", () => {
  const ENTRY = {
    key: "vote:P-01",
    value: true,
    updatedAt: new Date().toISOString(),
    author: { id: "user-2", name: "Someone", email: "someone@acme.example" },
  };

  function withActivation(isActive: boolean) {
    Object.defineProperty(navigator, "userActivation", { value: { isActive }, configurable: true });
  }

  afterEach(() => {
    delete (navigator as { userActivation?: unknown }).userActivation;
  });

  test("gives the artifact its entries, without anyone's email", async () => {
    stubFetch((path) =>
      path.endsWith("/entries") ? { body: { entries: [ENTRY], schema: null } } : answer(path),
    );
    renderFull();
    const frame = (await screen.findByTitle("Preview of Sales chart")) as HTMLIFrameElement;
    const sent = stubPostMessage(frame);
    await screen.findByText("1 data entry");

    await sendFromFrame(frame, { type: "ready" });

    expect(sent).toContainEqual({
      portego: 1,
      type: "entries",
      entries: [
        {
          key: "vote:P-01",
          value: true,
          authorId: "user-2",
          author: "Someone",
          updatedAt: ENTRY.updatedAt,
        },
      ],
    });
    expect(JSON.stringify(sent)).not.toContain("someone@acme.example");
  });

  test("records an entry the artifact asks for during the reader's click, and says so", async () => {
    const writes: { path: string; method?: string; body?: unknown }[] = [];
    stubFetch((path, init) => {
      if (path.includes("/entries") && init?.method) {
        writes.push({ path, method: init.method, body: init.body });
        return init.method === "PUT" ? { body: { entry: ENTRY } } : { status: 204, body: null };
      }
      return answer(path);
    });
    renderFull();
    const frame = (await screen.findByTitle("Preview of Sales chart")) as HTMLIFrameElement;
    withActivation(true);

    await sendFromFrame(frame, { type: "set", key: "vote:P-01", value: true });

    expect(await screen.findByText("Saved vote:P-01")).toBeDefined();
    expect(writes).toEqual([
      {
        path: "/api/artifacts/artifact-1/entries",
        method: "PUT",
        body: JSON.stringify({ key: "vote:P-01", value: true }),
      },
    ]);
  });

  test("ignores a write the artifact asks for without a click, so a page cannot act as its reader", async () => {
    const writes: string[] = [];
    stubFetch((path, init) => {
      if (path.includes("/entries") && init?.method) writes.push(init.method);
      return answer(path);
    });
    renderFull();
    const frame = (await screen.findByTitle("Preview of Sales chart")) as HTMLIFrameElement;
    withActivation(false);

    await sendFromFrame(frame, { type: "set", key: "vote:P-01", value: true });
    await sendFromFrame(frame, { type: "clear", key: "vote:P-01" });

    expect(writes).toEqual([]);
    expect(screen.queryByText("Saved vote:P-01")).toBeNull();
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
    // Only the artifact itself is counted: the heading waits for it, while
    // the other first-load requests may still be on their way.
    let loads = 0;
    stubFetch((path) => {
      if ((path.split("?")[0] ?? path) === "/api/artifacts/artifact-1") loads += 1;
      return answer(path);
    });
    renderFull();
    await screen.findByRole("heading", { name: /Sales chart/ });
    expect(loads).toBe(1);

    await announce({ type: "artifact.changed", id: "artifact-2" });
    await announce({ type: "artifact.changed", id: "artifact-1" });

    // The second announcement shows events are handled; only it reloads.
    await waitFor(() => expect(loads).toBe(2));
  });
});

describe("change notices", () => {
  const someoneElse = { id: "user-2", name: "B Person", email: "b@acme.example" };
  const me = { id: "user-1", name: "A Person", email: "person@acme.example" };

  function comment(overrides: Partial<Comment> = {}): Comment {
    return {
      id: "comment-1",
      body: "Looks right",
      createdAt: new Date().toISOString(),
      author: someoneElse,
      anchor: null,
      parentId: null,
      versionId: "artifact-1",
      versionNumber: 1,
      inApp: false,
      ...overrides,
    };
  }

  /**
   * Answers from `lists` at request time, so a test can change them before
   * announcing. A posted comment joins the list at once; with `holdPosts` its
   * response waits for `release`.
   */
  function stubLists(
    lists: { versions: ArtifactVersion[]; comments: Comment[] },
    options: { holdPosts?: boolean } = {},
  ) {
    const held: (() => void)[] = [];
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    stubFetchWith((path, init) => {
      const base = path.split("?")[0] ?? path;
      if (base.endsWith("/comments") && init?.method === "POST") {
        const { body } = JSON.parse(String(init.body)) as { body: string };
        const created = comment({
          id: `posted-${lists.comments.length}`,
          body,
          author: me,
          inApp: true,
        });
        lists.comments = [...lists.comments, created];
        if (!options.holdPosts) return Promise.resolve(json({ comment: created }, 201));
        return new Promise((resolve) => held.push(() => resolve(json({ comment: created }, 201))));
      }
      if (base.endsWith("/versions")) return Promise.resolve(json({ versions: lists.versions }));
      if (base.endsWith("/comments")) return Promise.resolve(json({ comments: lists.comments }));
      if (base.endsWith("/artifact-1")) {
        return Promise.resolve(
          json({ artifact: artifact({ currentVersionId: lists.versions[0]?.id }) }),
        );
      }
      return Promise.resolve(json(answer(path).body));
    });
    return {
      release: () => {
        for (const respond of held.splice(0)) respond();
      },
    };
  }

  async function postComment(body: string) {
    await userEvent.click(await screen.findByRole("button", { name: "Versions & comments" }));
    await userEvent.type(screen.getByLabelText("Add a comment"), body);
    await userEvent.click(screen.getByRole("button", { name: "Comment" }));
  }

  async function renderWithVersions() {
    renderFull();
    await userEvent.click(await screen.findByRole("button", { name: "Versions & comments" }));
    await screen.findByRole("button", { name: "Version 1, current" });
  }

  test("tells the reader who uploaded a new version, but not about the versions already there", async () => {
    const lists = { versions: [version({ creator: someoneElse })], comments: [] };
    stubLists(lists);
    await renderWithVersions();
    expect(screen.queryByText(/uploaded version/)).toBeNull();

    lists.versions = [
      version({ id: "v2", number: 2, creator: someoneElse, inApp: true }),
      ...lists.versions,
    ];
    await announce({ type: "artifact.changed", id: "artifact-1" });

    expect(await screen.findByText("B Person uploaded version 2")).toBeDefined();
  });

  test("tells the reader about a version uploaded under their own account, e.g. by their agent", async () => {
    const lists = { versions: [version({ creator: me })], comments: [] };
    stubLists(lists);
    await renderWithVersions();

    lists.versions = [version({ id: "v2", number: 2, creator: me }), ...lists.versions];
    await announce({ type: "artifact.changed", id: "artifact-1" });

    expect(await screen.findByText("A Person uploaded version 2")).toBeDefined();
  });

  test("does not tell the reader about a version they uploaded in the web app", async () => {
    const lists = { versions: [version({ creator: me })], comments: [] };
    stubLists(lists);
    await renderWithVersions();

    lists.versions = [
      version({ id: "v2", number: 2, creator: me, inApp: true }),
      ...lists.versions,
    ];
    await announce({ type: "artifact.changed", id: "artifact-1" });

    await screen.findByRole("button", { name: "Version 2, current" });
    await act(async () => {});
    expect(screen.queryByText(/uploaded version/)).toBeNull();
  });

  test("clicking a new version's notice takes a reader on an older version to the new one", async () => {
    const lists = {
      versions: [version({ id: "v1", number: 1, creator: someoneElse })],
      comments: [],
    };
    stubLists(lists);
    await renderWithVersions();
    await userEvent.click(screen.getByRole("button", { name: "Version 1, current" }));
    await userEvent.click(screen.getByRole("button", { name: "Close comments" }));

    lists.versions = [version({ id: "v2", number: 2, creator: someoneElse }), ...lists.versions];
    await announce({ type: "artifact.changed", id: "artifact-1" });
    await userEvent.click(
      await screen.findByRole("button", { name: "B Person uploaded version 2" }),
    );

    expect(
      screen.getByRole("button", { name: "Versions & comments" }).getAttribute("aria-pressed"),
    ).toBe("true");
    const newest = screen.getByRole("button", { name: "Version 2, current" });
    expect(newest.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByText("B Person uploaded version 2")).toBeNull();
  });

  test("tells the reader who commented, but not about the comments already there", async () => {
    const lists = { versions: [version()], comments: [comment()] };
    stubLists(lists);
    renderFull();
    await screen.findByText("Looks right");
    // The page hears about the list in an effect after it renders.
    await act(async () => {});
    expect(screen.queryByText(/commented/)).toBeNull();

    // Someone else's comment is news wherever they wrote it.
    lists.comments = [
      ...lists.comments,
      comment({ id: "comment-2", body: "One more thing", inApp: true }),
    ];
    await announce({ type: "comment.changed", artifactId: "artifact-1" });

    expect(await screen.findByText("B Person commented")).toBeDefined();
  });

  test("tells the reader about a comment their agent made under their account", async () => {
    const lists = { versions: [version()], comments: [comment()] };
    stubLists(lists);
    renderFull();
    await screen.findByText("Looks right");

    lists.comments = [...lists.comments, comment({ id: "comment-2", body: "Mine", author: me })];
    await announce({ type: "comment.changed", artifactId: "artifact-1" });

    expect(await screen.findByText("A Person commented")).toBeDefined();
  });

  test("does not tell the reader about a comment they wrote in the web app in another tab", async () => {
    const lists = { versions: [version()], comments: [comment()] };
    stubLists(lists);
    renderFull();
    await screen.findByText("Looks right");

    lists.comments = [
      ...lists.comments,
      comment({ id: "comment-2", body: "From my other tab", author: me, inApp: true }),
    ];
    await announce({ type: "comment.changed", artifactId: "artifact-1" });

    await screen.findByText("From my other tab");
    await act(async () => {});
    expect(screen.queryByText(/commented/)).toBeNull();
  });

  test("does not tell the reader about a comment they posted on this page", async () => {
    const lists = { versions: [version()], comments: [comment()] };
    stubLists(lists);
    renderFull();
    await screen.findByText("Looks right");

    await postComment("Posted here");
    await screen.findByText("Posted here");
    await announce({ type: "comment.changed", artifactId: "artifact-1" });
    await act(async () => {});

    expect(screen.queryByText(/commented/)).toBeNull();
  });

  test("does not tell the reader about their comment when the stream brings it back before the post answers", async () => {
    const lists = { versions: [version()], comments: [comment()] };
    const posts = stubLists(lists, { holdPosts: true });
    renderFull();
    await screen.findByText("Looks right");

    await postComment("Posted here");
    await announce({ type: "comment.changed", artifactId: "artifact-1" });
    // The composer still holds the draft until the post answers.
    await screen.findByText("Posted here", { selector: ".comment-body" });
    await act(async () => posts.release());
    await act(async () => {});

    expect(screen.queryByText(/commented/)).toBeNull();
  });

  test("clicking a comment's notice opens the panel on that comment and reveals it in the artifact", async () => {
    const lists = { versions: [version()], comments: [comment()] };
    stubLists(lists);
    renderFull();
    const frame = (await screen.findByTitle("Preview of Sales chart")) as HTMLIFrameElement;
    const sent = stubPostMessage(frame);
    await screen.findByText("Looks right");

    lists.comments = [...lists.comments, comment({ id: "comment-2", body: "One more thing" })];
    await announce({ type: "comment.changed", artifactId: "artifact-1" });
    await userEvent.click(await screen.findByRole("button", { name: "B Person commented" }));

    expect(
      screen.getByRole("button", { name: "Versions & comments" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(document.getElementById("comment-comment-2")?.className).toContain("focused");
    expect(sent).toContainEqual({ portego: 1, type: "reveal", id: "comment-2" });
  });

  test("clicking a notice for several comments goes to the first of them", async () => {
    const lists = { versions: [version()], comments: [comment()] };
    stubLists(lists);
    renderFull();
    await screen.findByText("Looks right");

    lists.comments = [
      ...lists.comments,
      comment({ id: "comment-2", body: "One more thing" }),
      comment({ id: "comment-3", body: "And another" }),
    ];
    await announce({ type: "comment.changed", artifactId: "artifact-1" });
    await userEvent.click(await screen.findByRole("button", { name: "2 new comments" }));

    expect(document.getElementById("comment-comment-2")?.className).toContain("focused");
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

  test("links each version's creator to their profile without selecting the version", async () => {
    stubTwoVersions();
    renderFull({ versionId: "v2" });

    await screen.findByRole("button", { name: "Version 1" });
    const creators = screen.getAllByRole("link", { name: "A Person" });
    expect(creators.map((link) => link.getAttribute("href"))).toContain("/u/user-1");
    const rowLink = creators.find((link) => link.closest(".version-row"));
    // A link inside the button would be invalid markup and hard to reach by keyboard.
    expect(rowLink?.closest("button")).toBeNull();

    await userEvent.click(rowLink as HTMLElement);
    expect(window.location.pathname).toBe("/u/user-1");
    expect(screen.getByRole("button", { name: "Version 1" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    window.history.replaceState(null, "", "/");
  });

  test("opens the panel on the version a link points at, then lets the link go", async () => {
    stubTwoVersions();
    let shown = 0;
    const onLinkShown = () => {
      shown += 1;
    };
    const { rerender } = renderFull({ versionId: "v1", onLinkShown });

    const older = await screen.findByRole("button", { name: "Version 1" });
    expect(older.getAttribute("aria-pressed")).toBe("true");
    expect(
      screen.getByRole("button", { name: "Versions & comments" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(shown).toBe(1);

    // The app drops the link; following it again later opens the panel again.
    rerender(<ArtifactFull {...fullProps({ versionId: null, onLinkShown })} />);
    await userEvent.click(screen.getByRole("button", { name: "Close comments" }));
    rerender(<ArtifactFull {...fullProps({ versionId: "v1", onLinkShown })} />);

    expect(
      screen.getByRole("button", { name: "Versions & comments" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(shown).toBe(2);
  });

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

  test("shows the viewed version in the header, so a reader knows which one they are reading", async () => {
    stubTwoVersions();
    renderFull();

    const pill = await screen.findByRole("button", { name: "Show versions, viewing version 2" });
    expect(pill.textContent).toBe("v2");

    await userEvent.click(pill);
    await userEvent.click(await screen.findByRole("button", { name: "Version 1" }));

    expect(
      screen.getByRole("button", { name: "Show versions, viewing version 1" }).textContent,
    ).toBe("v1");
  });

  test("the version in the header opens the panel on the versions, and keeps it open", async () => {
    stubTwoVersions();
    renderFull();
    const toggle = await screen.findByRole("button", { name: "Versions & comments" });
    const pill = await screen.findByRole("button", { name: /^Show versions/ });

    await userEvent.click(pill);

    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    const current = screen.getByRole("button", { name: "Version 2, current" });
    await waitFor(() => expect(document.activeElement).toBe(current));

    // A toggle would close the panel the reader asked to see.
    await userEvent.click(pill);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
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

  test("sends the artifact its comments, without the authors' emails", async () => {
    const createdAt = new Date().toISOString();
    stubTwoVersions((path) =>
      path.endsWith("/comments")
        ? {
            body: {
              comments: [
                {
                  id: "comment-1",
                  body: "Section two needs a source.",
                  createdAt,
                  author: { id: "user-2", name: "Someone", email: "s@x.test" },
                  anchor: null,
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
    await screen.findByText("Section two needs a source.");

    await sendFromFrame(frame, { type: "ready" });
    await waitFor(() =>
      expect(sent).toContainEqual({
        portego: 1,
        type: "comments",
        comments: [
          {
            id: "comment-1",
            body: "Section two needs a source.",
            author: "Someone",
            createdAt,
            anchor: null,
            parentId: null,
            versionNumber: 1,
          },
        ],
      }),
    );
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
    // With one version there is no other to tell it apart from.
    expect(screen.queryByRole("button", { name: /^Show versions/ })).toBeNull();

    listed = [version({ id: "v2", number: 2 }), version({ id: "v1", number: 1 })];
    currentVersionId = "v2";
    await announce({ type: "artifact.changed", id: "artifact-1" });

    expect(await screen.findByRole("button", { name: "Version 2, current" })).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Show versions, viewing version 2" }).textContent,
    ).toBe("v2");
  });
});
