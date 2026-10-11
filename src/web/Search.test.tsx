import { afterEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { SearchResults } from "./api.ts";
import { type FindResult, SearchField, SearchPopover } from "./Search.tsx";
import { artifact, restoreFetch, stubFetch } from "./testing.ts";

afterEach(restoreFetch);

function results(overrides: Partial<SearchResults> = {}): SearchResults {
  return {
    total: 3,
    artifacts: [
      {
        artifact: artifact({ id: "runbook", title: "Lampo rollback runbook" }),
        title: [{ text: "Lampo " }, { text: "rollback", match: true }, { text: " runbook" }],
        snippet: null,
      },
    ],
    content: [
      {
        artifact: artifact({ id: "checklist", title: "Launch checklist", versionCount: 3 }),
        snippet: [{ text: "…start the " }, { text: "rollback", match: true }, { text: " now…" }],
        matches: 2,
      },
    ],
    comments: [
      {
        artifact: artifact({ id: "status", title: "Cleanup status" }),
        comment: {
          id: "comment-1",
          author: { id: "user-2", name: "B Person" },
          createdAt: new Date().toISOString(),
        },
        snippet: [{ text: "Is there a " }, { text: "rollback", match: true }, { text: " path?" }],
      },
    ],
    tags: [{ id: "tag-1", name: "rollback", count: 4 }],
    folders: [],
    ...overrides,
  };
}

/** Records the search requests and answers each with `found`. */
function stubSearch(found: SearchResults = results()) {
  const requested: URLSearchParams[] = [];
  stubFetch((path) => {
    if (path.startsWith("/api/artifacts/search")) {
      requested.push(new URL(path, "http://app.test").searchParams);
      return { body: found };
    }
    if (path === "/api/folders") {
      return {
        body: {
          folders: [
            { id: "lampo", name: "Lampo", parentId: null, artifactCount: 1 },
            { id: "launch", name: "Launch", parentId: "lampo", artifactCount: 2 },
          ],
          rootArtifactCount: 0,
        },
      };
    }
    return { body: {} };
  });
  return requested;
}

function renderField(props: Partial<Parameters<typeof SearchField>[0]> = {}) {
  const onOpenArtifact = mock();
  const onOpenGallery = mock();
  render(<SearchField onOpenArtifact={onOpenArtifact} onOpenGallery={onOpenGallery} {...props} />);
  return { onOpenArtifact, onOpenGallery, field: screen.getByLabelText("Search everything") };
}

describe("the gallery's search field", () => {
  test("groups results by where they matched and marks the matched words", async () => {
    stubSearch();
    const { field } = renderField();
    await userEvent.type(field, "rollback");

    expect(await screen.findByText("Inside artifacts")).toBeDefined();
    expect(screen.getByText("Artifacts")).toBeDefined();
    expect(screen.getByText("Comments")).toBeDefined();
    expect(screen.getByText("B Person on Cleanup status")).toBeDefined();
    expect(screen.getByText("· 2 matches")).toBeDefined();
    const marked = document.querySelectorAll(".search-match");
    expect([...marked].map((element) => element.textContent)).toEqual([
      "rollback",
      "rollback",
      "rollback",
    ]);
  });

  test("Enter with no result picked filters the gallery to what the search counted", async () => {
    stubSearch();
    const { field, onOpenGallery, onOpenArtifact } = renderField({ folderId: "launch" });
    await userEvent.type(field, "rollback");
    await screen.findByText("Inside artifacts");

    await userEvent.keyboard("{Enter}");
    // The search ignores status and tags, so the gallery must too, or its count differs.
    expect(onOpenGallery).toHaveBeenCalledWith({
      query: "rollback",
      folderId: null,
      status: null,
      tagIds: [],
    });
    expect(onOpenArtifact).not.toHaveBeenCalled();
  });

  test("Enter in a cleared field clears the gallery's search", async () => {
    stubSearch();
    const { field, onOpenGallery } = renderField({ initialQuery: "rollback" });
    await userEvent.clear(field);
    await userEvent.keyboard("{Enter}");
    expect(onOpenGallery).toHaveBeenCalledWith({ query: "" });
  });

  test("the arrow keys pick a result and Enter opens it", async () => {
    stubSearch();
    const { field, onOpenArtifact } = renderField();
    await userEvent.type(field, "rollback");
    await screen.findByText("Inside artifacts");

    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(field.getAttribute("aria-activedescendant")).not.toBeNull();
    await userEvent.keyboard("{Enter}");
    // A match in the text opens the artifact finding the word as the text has it.
    expect(onOpenArtifact).toHaveBeenCalledWith("checklist", { find: "rollback" });
  });

  test("a comment opens on the comment, and a tag filters the gallery by it", async () => {
    stubSearch();
    const { field, onOpenArtifact, onOpenGallery } = renderField();
    await userEvent.type(field, "rollback");

    await userEvent.click(await screen.findByText("B Person on Cleanup status"));
    expect(onOpenArtifact).toHaveBeenCalledWith("status", { commentId: "comment-1" });

    await userEvent.click(field);
    await userEvent.click(await screen.findByRole("option", { name: /rollback 4/ }));
    expect(onOpenGallery).toHaveBeenCalledWith({ query: "", folderId: null, tagIds: ["tag-1"] });
  });

  test("offers the open folder as a scope, named with its parents", async () => {
    const requested = stubSearch(results({ total: 12 }));
    const { field, onOpenGallery } = renderField({ folderId: "launch" });
    await userEvent.type(field, "rollback");

    await userEvent.click(await screen.findByRole("button", { name: "In Lampo › Launch" }));
    await waitFor(() => expect(requested.at(-1)?.get("folderId")).toBe("launch"));

    await userEvent.click(screen.getByRole("button", { name: "Show all 12 artifacts" }));
    expect(onOpenGallery).toHaveBeenCalledWith({
      query: "rollback",
      folderId: "launch",
      status: null,
      tagIds: [],
    });
  });

  test("offers Show all only when the popup leaves some artifacts out", async () => {
    stubSearch();
    const { field } = renderField();
    await userEvent.type(field, "rollback");
    await screen.findByText("Inside artifacts");
    // Three artifacts, all three shown.
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
  });

  test("counts an artifact shown in several groups once", async () => {
    const runbook = artifact({ id: "runbook", title: "Lampo rollback runbook" });
    stubSearch(
      results({
        total: 2,
        content: [{ artifact: runbook, snippet: [{ text: "rollback", match: true }], matches: 1 }],
        comments: [],
      }),
    );
    const { field } = renderField();
    await userEvent.type(field, "rollback");
    // One artifact shown, in two groups, out of two.
    expect(await screen.findByRole("button", { name: "Show all 2 artifacts" })).toBeDefined();
  });

  test("says when nothing matches", async () => {
    stubSearch(results({ total: 0, artifacts: [], content: [], comments: [], tags: [] }));
    const { field } = renderField();
    await userEvent.type(field, "zzz");
    expect(await screen.findByText("Nothing matches “zzz”.")).toBeDefined();
  });

  test("/ focuses the field from anywhere outside a text field", async () => {
    stubSearch();
    const { field } = renderField();
    fireEvent.keyDown(document.body, { key: "/" });
    expect(document.activeElement).toBe(field);
  });
});

/**
 * Stands in for the artifact frame: it counts `total` matches of any query,
 * wraps the index like the frame does, and records every request.
 */
function FindHarness({ total, onClose = () => {} }: { total: number; onClose?: () => void }) {
  const [result, setResult] = useState<FindResult | null>(null);
  const run = (query: string, index: number) => {
    finds.push({ query, index });
    setResult(
      query.trim() === ""
        ? null
        : { count: total, index: total === 0 ? 0 : (index + total) % total, more: false },
    );
  };
  return (
    <SearchPopover
      find={{ result, run }}
      onOpenArtifact={() => {}}
      onOpenGallery={() => {}}
      onClose={onClose}
    />
  );
}

let finds: { query: string; index: number }[] = [];

async function findInArtifact(total: number) {
  finds = [];
  const requested = stubSearch();
  const view = render(<FindHarness total={total} />);
  const field = screen.getByLabelText("Search everything");
  expect(document.activeElement).toBe(field);
  await userEvent.type(field, "rollback");
  await userEvent.click(await screen.findByRole("button", { name: "This artifact" }));
  return { field, requested, view };
}

describe("the artifact view's search popover", () => {
  test("finds in the artifact itself, like a browser, with no result list", async () => {
    const { requested } = await findInArtifact(5);
    expect(await screen.findByText("1 of 5")).toBeDefined();
    expect(finds.at(-1)).toEqual({ query: "rollback", index: 0 });
    // Only the search typed before the scope changed went to the server.
    const before = requested.length;
    await userEvent.keyboard("x");
    await waitFor(() => expect(finds.at(-1)?.query).toBe("rollbackx"));
    expect(requested.length).toBe(before);
    expect(screen.queryByText("Inside artifacts")).toBeNull();
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
  });

  test("Enter and the arrows loop through the matches in both directions", async () => {
    await findInArtifact(3);
    await screen.findByText("1 of 3");

    await userEvent.keyboard("{Enter}");
    expect(await screen.findByText("2 of 3")).toBeDefined();
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}{Shift>}{Enter}{/Shift}");
    // Back past the first match to the last.
    expect(await screen.findByText("3 of 3")).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "Next match" }));
    expect(await screen.findByText("1 of 3")).toBeDefined();
  });

  test("says when the artifact has no match", async () => {
    await findInArtifact(0);
    expect(await screen.findByText("No matches")).toBeDefined();
    expect((screen.getByRole("button", { name: "Next match" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  test("takes the marks off the artifact when it closes or the scope changes", async () => {
    const { view } = await findInArtifact(2);
    await screen.findByText("1 of 2");

    await userEvent.click(screen.getByRole("button", { name: "Everywhere" }));
    expect(finds.at(-1)).toEqual({ query: "", index: 0 });

    await userEvent.click(screen.getByRole("button", { name: "This artifact" }));
    await screen.findByText("1 of 2");
    view.unmount();
    expect(finds.at(-1)).toEqual({ query: "", index: 0 });
  });

  test("offers no find without an artifact on screen to search", async () => {
    stubSearch();
    render(<SearchPopover onOpenArtifact={() => {}} onOpenGallery={() => {}} onClose={() => {}} />);
    await userEvent.type(screen.getByLabelText("Search everything"), "rollback");
    await screen.findByText("Inside artifacts");
    expect(screen.queryByRole("button", { name: "This artifact" })).toBeNull();
  });

  test("shows that the artifact has more matches than the frame counted", async () => {
    stubSearch();
    function Capped() {
      const [result, setResult] = useState<FindResult | null>(null);
      return (
        <SearchPopover
          initialQuery="a"
          initialScope="artifact"
          find={{ result, run: () => setResult({ count: 1000, index: 0, more: true }) }}
          onOpenArtifact={() => {}}
          onOpenGallery={() => {}}
          onClose={() => {}}
        />
      );
    }
    render(<Capped />);
    expect(await screen.findByText("1 of 1000+")).toBeDefined();
  });

  test("closes on Escape", async () => {
    stubSearch();
    const onClose = mock();
    render(<FindHarness total={1} onClose={onClose} />);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});
