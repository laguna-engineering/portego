import { afterEach, describe, expect, test } from "bun:test";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Profile } from "./Profile.tsx";
import { restoreFetch, stubFetch } from "./testing.ts";

afterEach(() => {
  restoreFetch();
});

const DAY_FORMAT = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

type Request = { path: string; method: string; body: unknown };

function stub(
  activity = { uploads: [] as number[], versions: [] as number[], comments: [] as number[] },
): Request[] {
  const requests: Request[] = [];
  stubFetch((path, init) => {
    requests.push({ path, method: init?.method ?? "GET", body: init?.body });
    if (path === "/api/me/activity") return { body: activity };
    if (path === "/api/me/avatar") return { body: { avatar: null } };
    if (path.startsWith("/api/users/me-id/activity")) {
      return { body: { entries: [], total: 0, pageSize: 10 } };
    }
    return { body: {} };
  });
  return requests;
}

function renderProfile(avatar: string | null = null, displayName: string | null = null) {
  const changes: unknown[] = [];
  render(
    <Profile
      userId="me-id"
      email="person@acme.example"
      displayName={displayName}
      defaultName="A Person"
      avatar={avatar}
      onAvatarChange={(value) => changes.push(value)}
      onDisplayNameChange={(names) => changes.push(names)}
      onSignOut={() => {}}
      onOpenArtifact={() => {}}
    />,
  );
  return changes;
}

function cell(label: string): HTMLElement | null {
  return document.querySelector(`[data-label="${label}"]`);
}

function choose(file: File) {
  fireEvent.change(screen.getByLabelText("Avatar image"), { target: { files: [file] } });
}

describe("activity graph", () => {
  test("shades each local day by what the user did that day and totals the year", async () => {
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const lastWeek = new Date(today);
    lastWeek.setDate(lastWeek.getDate() - 7);
    const twoYearsAgo = new Date(today);
    twoYearsAgo.setFullYear(today.getFullYear() - 2);

    stub({
      uploads: [today.getTime(), twoYearsAgo.getTime()],
      versions: [today.getTime(), lastWeek.getTime()],
      comments: [today.getTime(), ...Array.from({ length: 7 }, () => lastWeek.getTime())],
    });
    renderProfile();

    expect(await screen.findByText("11 actions in the last year")).toBeDefined();
    const todayCell = cell(`3 actions on ${DAY_FORMAT.format(today)}`);
    expect(todayCell?.className).toContain("l2");
    const busiest = cell(`8 actions on ${DAY_FORMAT.format(lastWeek)}`);
    expect(busiest?.className).toContain("l4");

    // The upload from two years ago is outside the graph, so it is not counted.
    const totals = screen.getByText("Artifacts uploaded").parentElement as HTMLElement;
    expect(totals.querySelector("dd")?.textContent).toBe("1");
  });

  test("ends on today, so no cell is drawn for a day still to come", async () => {
    stub();
    renderProfile();

    await screen.findByText("0 actions in the last year");
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    expect(cell(`No actions on ${DAY_FORMAT.format(tomorrow)}`)).toBeNull();
    expect(cell(`No actions on ${DAY_FORMAT.format(new Date())}`)).not.toBeNull();
  });
  test("names the day and its count over the cell under the pointer", async () => {
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    stub({ uploads: [today.getTime()], versions: [], comments: [today.getTime()] });
    renderProfile();
    await screen.findByText("2 actions in the last year");

    const label = `2 actions on ${DAY_FORMAT.format(today)}`;
    fireEvent.pointerOver(cell(label) as HTMLElement);
    expect(screen.getByRole("tooltip").textContent).toBe(label);

    fireEvent.pointerLeave(document.querySelector(".activity-grid") as HTMLElement);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});

describe("avatar", () => {
  test("opens the crop dialog for the chosen image and sends nothing until it is saved", async () => {
    const requests = stub();
    const changes = renderProfile();

    choose(new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "me.png", { type: "image/png" }));

    const dialog = await screen.findByRole("dialog", { name: "Position your avatar" });
    expect(requests.some((request) => request.method === "PUT")).toBe(false);

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(requests.some((request) => request.method === "PUT")).toBe(false);
    expect(changes).toEqual([]);
  });

  test("refuses a file that is not an image without opening the dialog", async () => {
    const requests = stub();
    const changes = renderProfile();

    choose(new File(["<svg/>"], "me.svg", { type: "text/plain" }));

    expect((await screen.findByRole("alert")).textContent).toContain("not an image");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(requests.some((request) => request.method === "PUT")).toBe(false);
    expect(changes).toEqual([]);
  });

  test("takes an image over the server's 1 MiB, since the crop is what gets saved", async () => {
    stub();
    renderProfile();

    choose(new File([new Uint8Array(2 * 1024 * 1024)], "photo.png", { type: "image/png" }));

    expect(await screen.findByRole("dialog", { name: "Position your avatar" })).toBeDefined();
  });

  test("refuses an image over 20 MiB without opening the dialog", async () => {
    stub();
    renderProfile();

    choose(new File([new Uint8Array(20 * 1024 * 1024 + 1)], "huge.png", { type: "image/png" }));

    expect((await screen.findByRole("alert")).textContent).toContain("The limit is 20 MiB.");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("removes the avatar, which brings back the initial", async () => {
    const requests = stub();
    const changes = renderProfile("/api/me/avatar?v=1");

    fireEvent.click(screen.getByRole("button", { name: "Remove avatar" }));

    await waitFor(() => expect(changes).toEqual([null]));
    expect(requests.some((r) => r.path === "/api/me/avatar" && r.method === "DELETE")).toBe(true);
  });
});

describe("display name", () => {
  function stubNames(): Request[] {
    const requests: Request[] = [];
    stubFetch((path, init) => {
      requests.push({ path, method: init?.method ?? "GET", body: init?.body });
      if (path === "/api/me/display-name") {
        const { displayName } = JSON.parse(String(init?.body)) as { displayName: string };
        const chosen = displayName.trim() || null;
        return {
          body: { name: chosen ?? "A Person", displayName: chosen, defaultName: "A Person" },
        };
      }
      if (path === "/api/me/activity") return { body: { uploads: [], versions: [], comments: [] } };
      return { body: { entries: [], total: 0, pageSize: 10 } };
    });
    return requests;
  }

  test("offers the name sign-in recorded until the user chooses another, and saves the choice", async () => {
    const requests = stubNames();
    const changes = renderProfile();

    const input = screen.getByLabelText("Display name") as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("A Person");
    // Nothing to save until the name differs from what is stored.
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();

    fireEvent.change(input, { target: { value: "Ada" } });
    fireEvent.click(save);

    await waitFor(() =>
      expect(changes).toEqual([{ name: "Ada", displayName: "Ada", defaultName: "A Person" }]),
    );
    const sent = requests.find((request) => request.path === "/api/me/display-name");
    expect(sent?.method).toBe("PUT");
    expect(JSON.parse(String(sent?.body))).toEqual({ displayName: "Ada" });
    expect(screen.getByText("Saved.")).toBeDefined();
  });

  test("resets a chosen name to the one sign-in recorded", async () => {
    stubNames();
    const changes = renderProfile(null, "Ada");

    expect((screen.getByLabelText("Display name") as HTMLInputElement).value).toBe("Ada");
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));

    await waitFor(() =>
      expect(changes).toEqual([{ name: "A Person", displayName: null, defaultName: "A Person" }]),
    );
    expect((screen.getByLabelText("Display name") as HTMLInputElement).value).toBe("");
  });

  test("shows what the server refused and keeps the draft", async () => {
    stubFetch((path) =>
      path === "/api/me/display-name"
        ? {
            status: 400,
            body: {
              error: {
                code: "INVALID_INPUT",
                message: "The display name can be at most 80 characters.",
              },
            },
          }
        : path === "/api/me/activity"
          ? { body: { uploads: [], versions: [], comments: [] } }
          : { body: { entries: [], total: 0, pageSize: 10 } },
    );
    const changes = renderProfile();

    const input = screen.getByLabelText("Display name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Too long" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "The display name can be at most 80 characters.",
    );
    expect(input.value).toBe("Too long");
    expect(changes).toEqual([]);
  });
});
