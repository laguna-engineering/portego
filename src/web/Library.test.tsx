import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ARTIFACT_DRAG_TYPE } from "./ArtifactCard.tsx";
import type { Folder, Tag } from "./api.ts";
import { FOLDER_DRAG_TYPE, Library } from "./Library.tsx";
import { ROOT_FOLDER_ID } from "./router.ts";
import { restoreFetch, StubEventSource, stubFetch } from "./testing.ts";

afterEach(restoreFetch);
beforeEach(() => {
  StubEventSource.install();
  window.localStorage.clear();
});

function folder(id: string, name: string, parentId: string | null = null, count = 0): Folder {
  return { id, name, parentId, artifactCount: count };
}

function tag(id: string, name: string): Tag {
  return { id, name, artifactCount: 1 };
}

function stubLibrary(folders: Folder[], tags: Tag[] = [], rootArtifactCount = 0) {
  stubFetch((path) => {
    if (path === "/api/folders") return { body: { folders, rootArtifactCount } };
    if (path === "/api/tags") return { body: { tags } };
    return { status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } };
  });
}

type Filter = { folderId?: string | null; tagIds?: string[] };

function renderLibrary(
  options: {
    folderId?: string | null;
    tagIds?: string[];
    onFilter?: (filters: Filter) => void;
  } = {},
) {
  return render(
    <Library
      appName="Acme"
      folderId={options.folderId ?? null}
      tagIds={options.tagIds ?? []}
      onFilter={options.onFilter ?? (() => {})}
    />,
  );
}

function folderNames(): string[] {
  const list = screen.getByRole("list");
  return [...list.querySelectorAll(".library-folder-name")].map((node) => node.textContent ?? "");
}

describe("folders", () => {
  test("lists each folder under its parent, so the tree reads top to bottom", async () => {
    stubLibrary([
      folder("lampo", "Lampo"),
      folder("portego", "Portego"),
      folder("launch", "Launch", "lampo"),
      folder("week-1", "Week 1", "launch"),
    ]);
    renderLibrary();

    await userEvent.click(await screen.findByRole("button", { name: "Subfolders of Lampo" }));
    await userEvent.click(screen.getByRole("button", { name: "Subfolders of Launch" }));
    expect(folderNames()).toEqual(["Acme", "Lampo", "Launch", "Week 1", "Portego"]);
  });

  test("starts collapsed and remembers which folders were opened, so a deep tree stays short", async () => {
    stubLibrary([folder("lampo", "Lampo"), folder("launch", "Launch", "lampo")]);
    const first = renderLibrary();

    const disclosure = await screen.findByRole("button", { name: "Subfolders of Lampo" });
    expect(folderNames()).toEqual(["Acme", "Lampo"]);
    await userEvent.click(disclosure);
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    first.unmount();

    renderLibrary();
    await screen.findByText("Launch");
    expect(folderNames()).toEqual(["Acme", "Lampo", "Launch"]);
  });

  test("opens the ancestors of the selected folder, so the selection is never hidden", async () => {
    stubLibrary([
      folder("lampo", "Lampo"),
      folder("launch", "Launch", "lampo"),
      folder("week-1", "Week 1", "launch"),
    ]);
    renderLibrary({ folderId: "week-1" });

    expect(await screen.findByRole("button", { name: /Week 1/, pressed: true })).toBeDefined();

    // A refresh after the reader collapses a parent leaves it collapsed.
    await userEvent.click(screen.getByRole("button", { name: "Subfolders of Lampo" }));
    await act(async () => {
      StubEventSource.last?.send({ type: "folder.changed", id: "lampo" });
    });
    expect(folderNames()).toEqual(["Acme", "Lampo"]);
  });

  test("shows each folder's count and marks the selected folder", async () => {
    stubLibrary([folder("lampo", "Lampo", null, 3), folder("portego", "Portego", null, 9)]);
    renderLibrary({ folderId: "portego" });

    const selected = await screen.findByRole("button", { name: /Portego/, pressed: true });
    expect(selected.textContent).toContain("9");
    expect(screen.getByRole("button", { name: "All artifacts" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  test("shows the root under the app name, with the count of artifacts in no folder", async () => {
    stubLibrary([folder("lampo", "Lampo")], [], 4);
    const filtered: Filter[] = [];
    renderLibrary({ folderId: ROOT_FOLDER_ID, onFilter: (filters) => filtered.push(filters) });

    const root = await screen.findByRole("button", { name: /Acme/, pressed: true });
    expect(root.textContent).toContain("4");
    // All artifacts is a separate view, so it is not selected at the root.
    expect(screen.getByRole("button", { name: "All artifacts" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    await userEvent.click(screen.getByRole("button", { name: "All artifacts" }));
    await userEvent.click(root);
    expect(filtered).toEqual([{ folderId: null }, { folderId: ROOT_FOLDER_ID }]);
  });

  test("reports the folder a person picked, and All clears it", async () => {
    stubLibrary([folder("lampo", "Lampo")]);
    const filtered: Filter[] = [];
    renderLibrary({ folderId: "lampo", onFilter: (filters) => filtered.push(filters) });

    await userEvent.click(await screen.findByRole("button", { name: /Lampo/ }));
    await userEvent.click(screen.getByRole("button", { name: "All artifacts" }));
    expect(filtered).toEqual([{ folderId: "lampo" }, { folderId: null }]);
  });

  test("reloads when someone changes a folder, because names and counts come from the server", async () => {
    let folders = [folder("lampo", "Lampo")];
    stubFetch((path) => ({
      body: path === "/api/folders" ? { folders } : { tags: [] },
    }));
    renderLibrary();
    await screen.findByText("Lampo");

    folders = [folder("lampo", "Lampo launch")];
    await act(async () => {
      StubEventSource.last?.send({ type: "folder.changed", id: "lampo" });
    });
    expect(await screen.findByText("Lampo launch")).toBeDefined();
  });

  test("reports a failure and offers to retry", async () => {
    let attempts = 0;
    stubFetch((path) => {
      if (path === "/api/tags") return { body: { tags: [] } };
      attempts += 1;
      return attempts === 1
        ? { status: 500, body: { error: { code: "INTERNAL", message: "Something went wrong." } } }
        : { body: { folders: [folder("lampo", "Lampo")] } };
    });
    renderLibrary();

    expect((await screen.findByRole("alert")).textContent).toBe("Something went wrong.");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Lampo")).toBeDefined();
  });
});

describe("new folders", () => {
  /** Serves a folder list that grows with each POST, and records what was posted. */
  function stubCreation(start: Folder[], refuse?: string) {
    const folders = [...start];
    const posted: unknown[] = [];
    stubFetch((path, init) => {
      if (path === "/api/folders" && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        posted.push(body);
        if (refuse)
          return { status: 400, body: { error: { code: "INVALID_INPUT", message: refuse } } };
        const created = folder(`id-${body.name}`, body.name, body.parentId ?? null);
        folders.push(created);
        return { status: 201, body: { folder: created } };
      }
      if (path === "/api/folders") return { body: { folders } };
      return { body: { tags: [] } };
    });
    return posted;
  }

  test("creates the folder inside the selected one, where the reader is browsing", async () => {
    const posted = stubCreation([folder("lampo", "Lampo")]);
    renderLibrary({ folderId: "lampo" });

    await userEvent.click(await screen.findByRole("button", { name: "New folder" }));
    await userEvent.type(screen.getByLabelText("New folder in Lampo"), "Launch{Enter}");

    await screen.findByText("Launch");
    expect(posted).toEqual([{ name: "Launch", parentId: "lampo" }]);
    expect(folderNames()).toEqual(["Acme", "Lampo", "Launch"]);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "New folder" })),
    );
  });

  test("creates a top-level folder when All artifacts is selected", async () => {
    const posted = stubCreation([folder("lampo", "Lampo")]);
    renderLibrary();

    await userEvent.click(await screen.findByRole("button", { name: "New folder" }));
    await userEvent.type(screen.getByLabelText("New top-level folder"), "Events");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    await screen.findByText("Events");
    expect(posted).toEqual([{ name: "Events" }]);
  });

  test("keeps the name when the server refuses it, so it can be corrected", async () => {
    stubCreation([folder("lampo", "Lampo")], "A folder with that name already exists here.");
    renderLibrary();

    await userEvent.click(await screen.findByRole("button", { name: "New folder" }));
    const input = screen.getByLabelText("New top-level folder") as HTMLInputElement;
    await userEvent.type(input, "Lampo{Enter}");

    expect((await screen.findByRole("alert")).textContent).toBe(
      "A folder with that name already exists here.",
    );
    expect(input.value).toBe("Lampo");
  });

  test("cancels on Escape without asking the server", async () => {
    const posted = stubCreation([]);
    renderLibrary();

    await userEvent.click(await screen.findByRole("button", { name: "New folder" }));
    await userEvent.type(screen.getByLabelText("New top-level folder"), "Draft{Escape}");

    expect(screen.queryByLabelText("New top-level folder")).toBeNull();
    expect(posted).toEqual([]);
  });
});

describe("tags", () => {
  test("adds a tag to the selection and removes it on a second click", async () => {
    stubLibrary([], [tag("t1", "launch"), tag("t2", "review")]);
    const filtered: Filter[] = [];
    renderLibrary({ tagIds: ["t1"], onFilter: (filters) => filtered.push(filters) });

    await userEvent.click(await screen.findByRole("button", { name: "review" }));
    await userEvent.click(screen.getByRole("button", { name: "launch", pressed: true }));
    expect(filtered).toEqual([{ tagIds: ["t1", "t2"] }, { tagIds: [] }]);
  });

  test("shows the first tags, keeps a selected one visible, and reveals the rest on request", async () => {
    const tags = Array.from({ length: 12 }, (_, index) => tag(`t${index}`, `tag ${index}`));
    stubLibrary([], tags);
    renderLibrary({ tagIds: ["t11"] });

    await screen.findByText("tag 0");
    expect(screen.queryByText("tag 9")).toBeNull();
    expect(screen.getByRole("button", { name: "tag 11", pressed: true })).toBeDefined();

    await userEvent.click(screen.getByRole("button", { name: "More…" }));
    expect(screen.getByText("tag 9")).toBeDefined();
  });
});

describe("collapsing", () => {
  test("hides the panel behind a rail and moves focus to the button that brings it back", async () => {
    stubLibrary([folder("lampo", "Lampo")]);
    renderLibrary();

    await userEvent.click(await screen.findByRole("button", { name: "Hide folders" }));

    const nav = screen.getByRole("navigation", { name: "Folders and tags" });
    expect(nav.className).toContain("collapsed");
    // An inert panel keeps its buttons out of the tab order while it is hidden.
    expect(screen.getByText("Lampo").closest(".library-panel")?.hasAttribute("inert")).toBe(true);
    const show = screen.getByRole("button", { name: "Show folders" });
    await waitFor(() => expect(document.activeElement).toBe(show));

    await userEvent.click(show);
    expect(nav.className).not.toContain("collapsed");
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Hide folders" })),
    );
  });

  test("remembers a collapsed panel on the next visit", async () => {
    stubLibrary([]);
    const first = renderLibrary();
    await userEvent.click(await screen.findByRole("button", { name: "Hide folders" }));
    first.unmount();

    renderLibrary();
    expect(screen.getByRole("navigation").className).toContain("collapsed");
  });
});

describe("dropping artifacts and folders", () => {
  /** Serves the tree and records each artifact and folder move. */
  function stubMoves(folders: Folder[], refuse?: string) {
    const moves: { artifactId: string; body: unknown }[] = [];
    stubFetch((path, init) => {
      const folderMove = path.match(/^\/api\/folders\/([^/]+)$/);
      if (folderMove?.[1] && init?.method === "PATCH") {
        moves.push({ artifactId: `folder:${folderMove[1]}`, body: JSON.parse(String(init.body)) });
        if (refuse) return { status: 409, body: { error: { code: "CONFLICT", message: refuse } } };
        return { body: { folder: {} } };
      }
      const move = path.match(/^\/api\/artifacts\/([^/]+)\/organization$/);
      if (move?.[1] && init?.method === "PATCH") {
        moves.push({ artifactId: move[1], body: JSON.parse(String(init.body)) });
        if (refuse) return { status: 403, body: { error: { code: "FORBIDDEN", message: refuse } } };
        return { body: { artifact: {} } };
      }
      if (path === "/api/folders") return { body: { folders } };
      return { body: { tags: [] } };
    });
    return moves;
  }

  /** Carries an artifact id, or a folder id when it starts with "folder:". */
  function dataTransfer(item: string) {
    const type = item.startsWith("folder:") ? FOLDER_DRAG_TYPE : ARTIFACT_DRAG_TYPE;
    const id = item.replace(/^folder:/, "");
    return {
      types: [type],
      dropEffect: "none",
      effectAllowed: "uninitialized",
      setData: () => {},
      getData: (requested: string) => (requested === type ? id : ""),
    };
  }

  /** Starts dragging a folder row, as a person pressing on it would. */
  function pickUp(name: string) {
    fireEvent.dragStart(screen.getByRole("button", { name: new RegExp(`^${name}`) }), {
      dataTransfer: dataTransfer(`folder:${name.toLowerCase()}`),
    });
  }

  function row(name: string): HTMLElement {
    const node = screen.getByText(name).closest("li");
    if (!node) throw new Error(`No row for ${name}`);
    return node;
  }

  /** Gives a row a real height, so the pointer can aim at its top or bottom edge. */
  function layOut(node: HTMLElement) {
    node.getBoundingClientRect = () => ({ top: 100, height: 20 }) as DOMRect;
  }

  function drag(node: HTMLElement, artifactId: string, clientY = 0) {
    const event = createEvent.dragOver(node, { dataTransfer: dataTransfer(artifactId) });
    // happy-dom's DragEvent has no pointer position.
    Object.defineProperty(event, "clientY", { value: clientY });
    fireEvent(node, event);
  }

  function dropOn(node: HTMLElement, artifactId: string, clientY = 0) {
    drag(node, artifactId, clientY);
    fireEvent.drop(node, { dataTransfer: dataTransfer(artifactId) });
  }

  test("files the artifact in the folder it is dropped on, highlighted while it is held there", async () => {
    const moves = stubMoves([folder("lampo", "Lampo"), folder("portego", "Portego")]);
    renderLibrary();
    await screen.findByText("Portego");

    drag(row("Portego"), "a1");
    expect(screen.getByRole("button", { name: /Portego/ }).className).toContain("drop-target");

    fireEvent.drop(row("Portego"), { dataTransfer: dataTransfer("a1") });
    await waitFor(() =>
      expect(moves).toEqual([{ artifactId: "a1", body: { folderId: "portego" } }]),
    );
    expect(screen.getByRole("button", { name: /Portego/ }).className).not.toContain("drop-target");
  });

  test("files the artifact in the parent level when it is dropped in the gap between rows", async () => {
    const moves = stubMoves([
      folder("lampo", "Lampo"),
      folder("launch", "Launch", "lampo"),
      folder("press", "Press", "lampo"),
    ]);
    window.localStorage.setItem("portego.library-expanded", JSON.stringify(["lampo"]));
    renderLibrary();
    await screen.findByText("Press");

    const press = row("Press");
    layOut(press);
    drag(press, "a1", 101);
    // The line marks the gap, and the folder that receives the drop is shown too.
    expect(press.className).toBe("drop-before");
    expect(screen.getByRole("button", { name: /^Lampo/ }).className).toContain("drop-parent");

    dropOn(press, "a1", 101);
    await waitFor(() => expect(moves).toEqual([{ artifactId: "a1", body: { folderId: "lampo" } }]));
  });

  test("unfiles the artifact when it is dropped on the root or in a top-level gap", async () => {
    const moves = stubMoves([folder("lampo", "Lampo")]);
    renderLibrary();
    await screen.findByText("Lampo");

    dropOn(row("Acme"), "a1");
    const lampo = row("Lampo");
    layOut(lampo);
    dropOn(lampo, "a2", 119);

    await waitFor(() =>
      expect(moves).toEqual([
        { artifactId: "a1", body: { folderId: null } },
        { artifactId: "a2", body: { folderId: null } },
      ]),
    );
  });

  test("opens a collapsed folder held under the artifact, so its subfolders can be reached", async () => {
    stubMoves([folder("lampo", "Lampo"), folder("launch", "Launch", "lampo")]);
    renderLibrary();
    await screen.findByText("Lampo");

    drag(row("Lampo"), "a1");
    expect(screen.queryByText("Launch")).toBeNull();
    expect(await screen.findByText("Launch", {}, { timeout: 2000 })).toBeDefined();
  });

  test("does not accept a drop on All artifacts, which shows every artifact wherever it is filed", async () => {
    const moves = stubMoves([folder("lampo", "Lampo")]);
    renderLibrary();
    const all = await screen.findByRole("button", { name: "All artifacts" });

    drag(all, "a1");
    fireEvent.drop(all, { dataTransfer: dataTransfer("a1") });

    expect(all.className).not.toContain("drop");
    expect(moves).toEqual([]);
  });

  test("does not open a folder the artifact only passes over", async () => {
    stubMoves([folder("lampo", "Lampo"), folder("launch", "Launch", "lampo")]);
    renderLibrary();
    await screen.findByText("Lampo");

    drag(row("Lampo"), "a1");
    drag(row("Acme"), "a1");
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(screen.queryByText("Launch")).toBeNull();
  });

  test("ignores drags that carry no artifact, such as files from the desktop", async () => {
    const moves = stubMoves([folder("lampo", "Lampo")]);
    renderLibrary();
    await screen.findByText("Lampo");

    const files = { types: ["Files"], dropEffect: "none", getData: () => "" };
    fireEvent.dragOver(row("Lampo"), { dataTransfer: files });
    fireEvent.drop(row("Lampo"), { dataTransfer: files });

    expect(screen.getByRole("button", { name: /Lampo/ }).className).not.toContain("drop-target");
    expect(moves).toEqual([]);
  });

  test("reports a move the server refuses", async () => {
    stubMoves([folder("lampo", "Lampo")], "You cannot change this artifact.");
    renderLibrary();
    await screen.findByText("Lampo");

    dropOn(row("Lampo"), "a1");
    expect((await screen.findByRole("alert")).textContent).toBe("You cannot change this artifact.");
  });

  test("moves a folder into the folder it is dropped on", async () => {
    const moves = stubMoves([folder("lampo", "Lampo"), folder("press", "Press")]);
    renderLibrary();
    await screen.findByText("Press");

    pickUp("Press");
    dropOn(row("Lampo"), "folder:press");

    await waitFor(() =>
      expect(moves).toEqual([{ artifactId: "folder:press", body: { parentId: "lampo" } }]),
    );
  });

  test("moves a folder to the top level when it is dropped on the root", async () => {
    const moves = stubMoves([folder("lampo", "Lampo"), folder("press", "Press", "lampo")]);
    window.localStorage.setItem("portego.library-expanded", JSON.stringify(["lampo"]));
    renderLibrary();
    await screen.findByText("Press");

    pickUp("Press");
    dropOn(row("Acme"), "folder:press");

    await waitFor(() =>
      expect(moves).toEqual([{ artifactId: "folder:press", body: { parentId: null } }]),
    );
  });

  test("refuses to put a folder inside itself or one of its descendants", async () => {
    const moves = stubMoves([
      folder("lampo", "Lampo"),
      folder("launch", "Launch", "lampo"),
      folder("week", "Week", "launch"),
    ]);
    window.localStorage.setItem("portego.library-expanded", JSON.stringify(["lampo", "launch"]));
    renderLibrary();
    await screen.findByText("Week");

    pickUp("Lampo");
    for (const name of ["Lampo", "Launch", "Week"]) {
      dropOn(row(name), "folder:lampo");
      expect(screen.getByRole("button", { name: new RegExp(`^${name}`) }).className).not.toContain(
        "drop",
      );
    }
    // The gap inside Launch would also file Lampo under its own descendant.
    const week = row("Week");
    layOut(week);
    dropOn(week, "folder:lampo", 101);
    expect(week.className).not.toContain("drop-before");

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(moves).toEqual([]);
  });

  test("sends nothing when a folder is dropped back into its own parent", async () => {
    const moves = stubMoves([folder("lampo", "Lampo"), folder("press", "Press", "lampo")]);
    window.localStorage.setItem("portego.library-expanded", JSON.stringify(["lampo"]));
    renderLibrary();
    await screen.findByText("Press");

    pickUp("Press");
    dropOn(row("Lampo"), "folder:press");

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(moves).toEqual([]);
  });

  test("reports a folder move the server refuses, such as a name taken in the new parent", async () => {
    stubMoves(
      [folder("lampo", "Lampo"), folder("press", "Press")],
      "A folder with that name already exists here.",
    );
    renderLibrary();
    await screen.findByText("Press");

    pickUp("Press");
    dropOn(row("Lampo"), "folder:press");

    expect((await screen.findByRole("alert")).textContent).toBe(
      "A folder with that name already exists here.",
    );
  });
});
