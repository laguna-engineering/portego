import { afterEach, describe, expect, test } from "bun:test";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { HistoryEntry } from "./api.ts";
import { MemberLink, MemberProfile } from "./Member.tsx";
import { restoreFetch, stubFetch } from "./testing.ts";

afterEach(() => {
  restoreFetch();
  window.history.replaceState(null, "", "/");
});

const DAY = 24 * 60 * 60 * 1000;

function entry(overrides: Partial<HistoryEntry> & Pick<HistoryEntry, "id" | "kind">): HistoryEntry {
  return {
    versionNumber: null,
    createdAt: Date.UTC(2026, 9, 5, 12),
    artifact: { id: "chart", title: "Sales chart", filename: "chart.html" },
    ...overrides,
  };
}

function stub(entries: HistoryEntry[], total = entries.length): string[] {
  const paths: string[] = [];
  stubFetch((path) => {
    paths.push(path);
    if (path === "/api/users/u1") {
      return {
        body: {
          user: {
            id: "u1",
            name: "Alberto Granzotto",
            joinedAt: Date.UTC(2026, 2, 10),
            avatar: null,
          },
          artifactCount: 4,
        },
      };
    }
    if (path.startsWith("/api/users/u1/activity"))
      return { body: { entries, total, pageSize: 10 } };
    return {
      status: 404,
      body: { error: { code: "NOT_FOUND", message: "There is no such member." } },
    };
  });
  return paths;
}

describe("member profile", () => {
  test("introduces the member and links each entry to what it was about", async () => {
    stub([
      entry({ id: "c1", kind: "commented", createdAt: Date.UTC(2026, 9, 5, 12) }),
      entry({ id: "v2", kind: "updated", versionNumber: 2, createdAt: Date.UTC(2026, 9, 4, 12) }),
      entry({ id: "v1", kind: "created", createdAt: Date.UTC(2026, 9, 3, 12) }),
    ]);
    const opened: unknown[] = [];
    render(
      <MemberProfile userId="u1" onOpenArtifact={(id, target) => opened.push([id, target])} />,
    );

    expect(await screen.findByRole("heading", { name: "Alberto Granzotto" })).toBeDefined();
    expect(screen.getByText("Joined March 2026 · worked on 4 artifacts")).toBeDefined();
    expect(await screen.findByText("Updated to v2")).toBeDefined();
    expect(screen.getByText("Created", { selector: ".history-kind" })).toBeDefined();

    // A comment opens on the comment and an update on its version, in the same tab.
    const links = screen.getAllByRole("link", { name: "Sales chart" });
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/a/chart?comment=c1",
      "/a/chart?version=v2",
      "/a/chart",
    ]);
    fireEvent.click(links[0] as HTMLElement);
    expect(opened).toEqual([["chart", { commentId: "c1" }]]);
  });

  test("asks the server for one kind, from the first page, when a chip is chosen", async () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      entry({ id: `c${i}`, kind: "commented", createdAt: Date.UTC(2026, 9, 5) - i * DAY }),
    );
    const paths = stub(many, 25);
    render(<MemberProfile userId="u1" onOpenArtifact={() => {}} />);

    expect(await screen.findByText("Page 1 of 3")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Older" }));
    await waitFor(() => expect(paths).toContain("/api/users/u1/activity?page=1"));
    expect(await screen.findByText("Page 2 of 3")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Commented" }));
    await waitFor(() => expect(paths).toContain("/api/users/u1/activity?page=0&kind=commented"));
    expect(screen.getByRole("button", { name: "Commented" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  test("says when the member has done nothing the viewer can see", async () => {
    stub([]);
    render(<MemberProfile userId="u1" onOpenArtifact={() => {}} />);
    expect(await screen.findByText("No activity yet.")).toBeDefined();
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  test("reports a member who does not exist", async () => {
    stub([]);
    render(<MemberProfile userId="ghost" onOpenArtifact={() => {}} />);
    expect((await screen.findByRole("alert")).textContent).toBe("There is no such member.");
  });
});

describe("member link", () => {
  test("moves to the profile without a reload, so the app's router picks it up", () => {
    const seen: string[] = [];
    const onPopState = () => seen.push(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    render(<MemberLink id="u 1">A Person</MemberLink>);

    const link = screen.getByRole("link", { name: "A Person" });
    expect(link.getAttribute("href")).toBe("/u/u%201");
    fireEvent.click(link);
    window.removeEventListener("popstate", onPopState);
    expect(seen).toEqual(["/u/u%201"]);
  });
});
