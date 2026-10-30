import { afterEach, describe, expect, test } from "bun:test";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { GitHubAccount } from "./api.ts";
import { GitHubAccounts } from "./GitHubAccounts.tsx";
import { restoreFetch, stubFetch } from "./testing.ts";

const assign = window.location.assign;

afterEach(() => {
  restoreFetch();
  window.location.assign = assign;
  window.history.replaceState(null, "", "/");
});

const OCTOCAT: GitHubAccount = {
  id: "row-1",
  githubId: "101",
  login: "octocat",
  connectedAt: Date.UTC(2026, 9, 12, 12),
  updatedAt: Date.UTC(2026, 9, 12, 12),
};
const HUBOT: GitHubAccount = {
  id: "row-2",
  githubId: "202",
  login: "hubot",
  connectedAt: Date.UTC(2026, 9, 28, 12),
  updatedAt: Date.UTC(2026, 9, 28, 12),
};

type Request = { path: string; method: string; body: unknown };

const CONFIRM = "Disconnect octocat from Portego? You can connect it again at any time.";

/** A paragraph by its whole text, which a <strong> inside splits for the default matcher. */
const paragraph = (text: string) =>
  screen.queryByText((_, element) => element?.tagName === "P" && element.textContent === text);

function stub(
  accounts: GitHubAccount[],
  answer: (request: Request) => { status?: number; body?: unknown } | null = () => null,
) {
  const requests: Request[] = [];
  let current = accounts;
  stubFetch((path, init) => {
    const request = {
      path,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    requests.push(request);
    const answered = answer(request);
    if (answered) return answered;
    if (path === "/api/me/github-accounts") return { body: { accounts: current } };
    if (request.method === "DELETE") {
      current = current.filter((account) => path !== `/api/me/github-accounts/${account.id}`);
      return { body: { accounts: current } };
    }
    return { status: 404, body: { error: { code: "NOT_FOUND", message: "Not here." } } };
  });
  return requests;
}

describe("connecting", () => {
  test("starts GitHub's approval page and asks to come back to the profile either way", async () => {
    const visited: string[] = [];
    window.location.assign = ((url: string) => {
      visited.push(url);
    }) as typeof window.location.assign;
    const requests = stub([], ({ path }) =>
      path === "/api/auth/link-social"
        ? { body: { url: "https://github.com/login/oauth/authorize?state=s" } }
        : null,
    );
    render(<GitHubAccounts />);

    expect(await screen.findByText("No GitHub account connected.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Connect GitHub account" }));

    await waitFor(() =>
      expect(visited).toEqual(["https://github.com/login/oauth/authorize?state=s"]),
    );
    expect(requests.find((request) => request.path === "/api/auth/link-social")).toEqual({
      path: "/api/auth/link-social",
      method: "POST",
      body: {
        provider: "github",
        callbackURL: "/profile?github=connected",
        errorCallbackURL: "/profile?github=error",
      },
    });
    // The button cannot start a second approval while the browser leaves.
    expect(
      (screen.getByRole("button", { name: "Opening GitHub…" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  test("names the account that came back, which may be one that was already connected", async () => {
    window.history.replaceState(null, "", "/profile?github=connected");
    // Connected earlier, reconnected now: it was updated last, so it is the one named.
    stub([{ ...OCTOCAT, updatedAt: Date.UTC(2026, 9, 30) }, HUBOT]);
    render(<GitHubAccounts />);

    const status = await screen.findByRole("status");
    expect(status.textContent).toBe("Connected octocat.");
    expect(window.location.search).toBe("");
  });

  test("says why nothing was connected", async () => {
    const cases = [
      ["access_denied", "Access was not granted on GitHub. No account was connected."],
      [
        "account_already_linked_to_different_user",
        "That GitHub account is connected to someone else's Portego account. No account was connected.",
      ],
      [
        "unable_to_link_account",
        "GitHub did not finish connecting. No account was connected. Please try again.",
      ],
    ];
    for (const [code, message] of cases) {
      window.history.replaceState(null, "", `/profile?github=error&error=${code}`);
      stub([]);
      const view = render(<GitHubAccounts />);
      expect((await screen.findByRole("alert")).textContent).toBe(message ?? "");
      // A reload must not report it again.
      expect(window.location.search).toBe("");
      view.unmount();
    }
  });
});

describe("the list", () => {
  test("shows each account with a link to it and when it was connected", async () => {
    stub([OCTOCAT, HUBOT]);
    render(<GitHubAccounts />);

    const link = (await screen.findByRole("link", { name: "octocat" })) as HTMLAnchorElement;
    expect(link.href).toBe("https://github.com/octocat");
    expect(screen.getByText("Connected Oct 12, 2026")).toBeTruthy();
    expect(screen.getByRole("link", { name: "hubot" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect another account" })).toBeTruthy();
    expect(screen.queryByText("No GitHub account connected.")).toBeNull();
  });
});

describe("disconnecting", () => {
  test("asks first, and only the confirmation removes the account", async () => {
    const requests = stub([OCTOCAT, HUBOT]);
    render(<GitHubAccounts />);

    fireEvent.click(await screen.findByRole("button", { name: "Disconnect octocat" }));
    expect(paragraph(CONFIRM)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
    expect(screen.getByRole("link", { name: "octocat" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Disconnect octocat" }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));

    expect((await screen.findByRole("status")).textContent).toBe(
      "Disconnected octocat. You can connect it again at any time.",
    );
    expect(requests.filter((request) => request.method === "DELETE")).toEqual([
      { path: "/api/me/github-accounts/row-1", method: "DELETE", body: undefined },
    ]);
    expect(screen.queryByRole("link", { name: "octocat" })).toBeNull();
    expect(screen.getByRole("link", { name: "hubot" })).toBeTruthy();
  });

  test("keeps the account and says so when the server refuses", async () => {
    stub([OCTOCAT], ({ method }) =>
      method === "DELETE"
        ? {
            status: 404,
            body: { error: { code: "NOT_FOUND", message: "You have no such GitHub account." } },
          }
        : null,
    );
    render(<GitHubAccounts />);

    fireEvent.click(await screen.findByRole("button", { name: "Disconnect octocat" }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));

    expect((await screen.findByRole("alert")).textContent).toBe("You have no such GitHub account.");
    expect(paragraph(CONFIRM)).toBeTruthy();
  });
});
