import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { McpConsent } from "./McpConsent.tsx";
import { restoreFetch, stubFetch } from "./testing.ts";

let navigated: string[];

beforeEach(() => {
  navigated = [];
  // The component sends the browser to the authorization server. Test runs
  // share one document, so the navigation is recorded instead of performed.
  spyOn(window.location, "assign").mockImplementation((url: string) => {
    navigated.push(String(url));
  });
});

afterEach(() => {
  restoreFetch();
  (window.location.assign as unknown as { mockRestore: () => void }).mockRestore();
});

const QUERY = "?client_id=abc123&scope=artifacts%3Aread%20artifacts%3Awrite&response_type=code";

function stub(onConsent?: (body: unknown) => void) {
  stubFetch((path, init) => {
    if (path.startsWith("/api/auth/oauth2/get-client")) {
      return { body: { clientId: "abc123", clientName: "Claude" } };
    }
    if (path === "/api/auth/oauth2/consent") {
      onConsent?.(JSON.parse(String(init?.body)));
      return { body: { url: "https://client.test/callback?code=xyz" } };
    }
    return { body: {} };
  });
}

describe("consent", () => {
  test("names the client and what it asked for", async () => {
    stub();
    render(<McpConsent query={QUERY} />);

    expect(await screen.findByRole("heading", { name: /Claude/ })).toBeDefined();
    expect(screen.getByText("List and read shared artifacts")).toBeDefined();
    expect(screen.getByText("Upload new artifacts as you")).toBeDefined();
  });

  test("shows the client id when the client has no name to show", async () => {
    stubFetch(() => ({ status: 404, body: { error: { code: "NOT_FOUND", message: "gone" } } }));
    render(<McpConsent query={QUERY} />);

    expect(await screen.findByRole("heading", { name: /abc123/ })).toBeDefined();
  });

  test("passes the signed query back untouched when the user allows", async () => {
    const sent: { accept: boolean; oauth_query: string }[] = [];
    stub((body) => sent.push(body as { accept: boolean; oauth_query: string }));
    render(<McpConsent query={QUERY} />);

    await userEvent.click(await screen.findByRole("button", { name: "Allow" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ accept: true, oauth_query: QUERY });
    await waitFor(() => expect(navigated).toEqual(["https://client.test/callback?code=xyz"]));
  });

  test("reports a denial to the authorization server rather than doing nothing", async () => {
    const sent: { accept: boolean }[] = [];
    stub((body) => sent.push(body as { accept: boolean }));
    render(<McpConsent query={QUERY} />);

    await userEvent.click(await screen.findByRole("button", { name: "Deny" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.accept).toBe(false);
  });

  test("refuses an incomplete authorization link instead of guessing", () => {
    stub();
    render(<McpConsent query="?scope=artifacts%3Aread" />);

    expect(screen.getByRole("alert").textContent).toContain("incomplete");
  });

  test("says so when the authorization request cannot be completed", async () => {
    stubFetch((path) =>
      path === "/api/auth/oauth2/consent"
        ? {
            status: 400,
            body: { error: { code: "INVALID_INPUT", message: "That request expired." } },
          }
        : { body: { clientId: "abc123", clientName: "Claude" } },
    );
    render(<McpConsent query={QUERY} />);

    await userEvent.click(await screen.findByRole("button", { name: "Allow" }));
    expect((await screen.findByRole("alert")).textContent).toBe("That request expired.");
  });
});
