import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Entry } from "./api.ts";
import { Entries } from "./Entries.tsx";
import { restoreFetch, StubEventSource, stubFetch } from "./testing.ts";

afterEach(restoreFetch);
beforeEach(() => StubEventSource.install());

function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    key: "vote:P-01",
    value: true,
    updatedAt: new Date().toISOString(),
    author: { id: "user-1", name: "A Person", email: "person@acme.example" },
    ...overrides,
  };
}

describe("data entries", () => {
  test("show nothing until there is an entry, so the panel stays about discussion", async () => {
    const requested: string[] = [];
    stubFetch((path) => {
      requested.push(path);
      return { body: { entries: [], schema: null } };
    });
    const { container } = render(<Entries artifactId="artifact-1" currentUserId="user-1" />);
    await waitFor(() => expect(requested).toEqual(["/api/artifacts/artifact-1/entries"]));
    expect(container.innerHTML).toBe("");
  });

  test("let a person remove their own entry, including one a page recorded for them", async () => {
    let entries = [
      entry(),
      entry({ author: { id: "user-2", name: "Someone", email: "s@x.test" } }),
    ];
    const deleted: string[] = [];
    stubFetch((path, init) => {
      if (init?.method === "DELETE") {
        deleted.push(path);
        entries = entries.filter((item) => item.author.id !== "user-1");
        return { status: 204, body: null };
      }
      return { body: { entries, schema: null } };
    });
    render(<Entries artifactId="artifact-1" currentUserId="user-1" />);

    await userEvent.click(await screen.findByText("2 data entries"));
    const remove = screen.getAllByRole("button", { name: "Remove" });
    // Only the reader's own row offers removal.
    expect(remove).toHaveLength(1);
    await userEvent.click(remove[0] as HTMLElement);

    expect(deleted).toEqual(["/api/artifacts/artifact-1/entries?key=vote%3AP-01"]);
    await screen.findByText("1 data entry");
  });

  test("reload when someone else records an entry", async () => {
    let entries: Entry[] = [];
    stubFetch(() => ({ body: { entries, schema: null } }));
    render(<Entries artifactId="artifact-1" currentUserId="user-1" />);
    await waitFor(() => expect(StubEventSource.last).toBeDefined());

    entries = [entry()];
    await act(async () => {
      StubEventSource.last?.send({ type: "entry.changed", artifactId: "artifact-1" });
    });

    expect(await screen.findByText("1 data entry")).toBeDefined();
  });
});
