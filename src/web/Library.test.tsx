import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Folder, Tag } from "./api.ts";
import { Library } from "./Library.tsx";
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

function stubLibrary(folders: Folder[], tags: Tag[] = []) {
  stubFetch((path) => {
    if (path === "/api/folders") return { body: { folders } };
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

    await screen.findByText("Lampo");
    expect(folderNames()).toEqual(["All artifacts", "Lampo", "Launch", "Week 1", "Portego"]);
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
    expect(folderNames()).toEqual(["All artifacts", "Lampo", "Launch"]);
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
