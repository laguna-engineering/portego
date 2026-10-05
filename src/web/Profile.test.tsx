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
    return { body: {} };
  });
  return requests;
}

function renderProfile(avatar: string | null = null) {
  const changes: (string | null)[] = [];
  render(
    <Profile
      email="person@acme.example"
      avatar={avatar}
      onAvatarChange={(value) => changes.push(value)}
      onSignOut={() => {}}
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
