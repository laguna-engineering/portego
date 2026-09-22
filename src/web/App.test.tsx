import { afterEach, describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { App } from "./App.tsx";
import { artifact, restoreFetch, stubFetch, stubFetchWith } from "./testing.ts";

const assign = window.location.assign;

afterEach(() => {
  restoreFetch();
  window.location.assign = assign;
  window.history.replaceState(null, "", "/");
});

/** Holds the browser still, so a test that starts sign-in stays on the page. */
function captureNavigation(): string[] {
  const visited: string[] = [];
  window.location.assign = ((url: string) => {
    visited.push(url);
  }) as typeof window.location.assign;
  return visited;
}

const SIGNED_IN = {
  user: { id: "user-1", name: "A Person", email: "person@acme.example", image: null },
  limits: { maxUploadBytes: 5 * 1024 * 1024 },
};

function signedIn(path: string) {
  if (path === "/api/me") return { body: SIGNED_IN };
  if (path === "/api/artifacts/artifact-1") return { body: { artifact: artifact() } };
  if (path.endsWith("/preview")) return { body: { url: "http://127.0.0.1:5173/preview/token" } };
  if (path.endsWith("/versions")) return { body: { versions: [] } };
  if (path.startsWith("/api/artifacts")) return { body: { items: [artifact()], nextCursor: null } };
  if (path === "/api/folders") return { body: { folders: [] } };
  if (path === "/api/tags") return { body: { tags: [] } };
  return { body: {} };
}

function signedOut(path: string) {
  if (path === "/api/me") {
    return {
      status: 401,
      body: { error: { code: "UNAUTHENTICATED", message: "Sign in to continue." } },
    };
  }
  if (path === "/api/auth-providers")
    return { body: { providers: [{ id: "google", label: "Google" }] } };
  return { body: {} };
}

describe("signed out", () => {
  test("offers the providers the deployment enabled, naming none itself", async () => {
    stubFetch(signedOut);
    render(<App />);

    expect(await screen.findByRole("button", { name: "Continue with Google" })).toBeDefined();
  });

  test("says so when a refused callback sends the browser back", async () => {
    window.history.replaceState(null, "", "/?error=NOT_ADMITTED");
    stubFetch(signedOut);
    render(<App />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("not allowed");
    // The message survives, the query does not, so a reload does not repeat it.
    expect(window.location.search).toBe("");
  });

  /**
   * Clicks a provider on the sign-in page and reports where sign-in would send
   * the browser back to. Navigation is held here: letting it run would move the
   * test document to the provider and take every later test with it.
   */
  async function callbackFor(path: string): Promise<string> {
    window.history.replaceState(null, "", path);
    let callback = "";
    const visited = captureNavigation();
    stubFetch((requested, init) => {
      if (requested !== "/api/auth/sign-in/social") return signedOut(requested);
      callback = (JSON.parse(String(init?.body)) as { callbackURL: string }).callbackURL;
      return { body: { url: "https://provider.example/authorize" } };
    });

    const view = render(<App />);
    (await screen.findByRole("button", { name: "Continue with Google" })).click();
    await screen.findByRole("button", { name: "Continue with Google" });
    view.unmount();
    expect(visited).toEqual(["https://provider.example/authorize"]);
    return callback;
  }

  test("comes back to the page that was asked for, so a shared link survives sign-in", async () => {
    expect(await callbackFor("/a/artifact-1/full")).toBe("/a/artifact-1/full");
    expect(await callbackFor("/a/artifact-1")).toBe("/a/artifact-1");
    // The gallery keeps its filters, so the link reproduces the same view.
    expect(await callbackFor("/?q=latency")).toBe("/?q=latency");
  });

  test("has nowhere to return to from a path the app does not define", async () => {
    expect(await callbackFor("/nope")).toBe("/");
  });

  test("reports a deployment with no provider instead of showing nothing", async () => {
    stubFetch((path) =>
      path === "/api/auth-providers" ? { body: { providers: [] } } : signedOut(path),
    );
    render(<App />);

    expect(await screen.findByText(/No sign-in provider is configured/)).toBeDefined();
  });
});

describe("signed in", () => {
  test("shows the gallery and who is signed in", async () => {
    stubFetch(signedIn);
    render(<App />);

    expect(await screen.findByText("person@acme.example")).toBeDefined();
    expect(await screen.findByText("Sales chart")).toBeDefined();
  });

  test("opens the upload dialog from the gallery", async () => {
    stubFetch(signedIn);
    render(<App />);

    (await screen.findByRole("button", { name: "Upload" })).click();
    expect(await screen.findByRole("dialog")).toBeDefined();
  });

  test("reads the search term from the URL, so a link reproduces the view", async () => {
    window.history.replaceState(null, "", "/?q=latency");
    const requested: string[] = [];
    stubFetch((path) => {
      requested.push(path);
      return signedIn(path);
    });
    render(<App />);

    await screen.findByText("Sales chart");
    expect(requested.some((path) => path.includes("q=latency"))).toBe(true);
    expect((screen.getByLabelText("Search artifacts") as HTMLInputElement).value).toBe("latency");
  });
});

describe("artifact", () => {
  test("frames the artifact under the masthead", async () => {
    window.history.replaceState(null, "", "/a/artifact-1");
    stubFetch(signedIn);
    render(<App />);

    const frame = await screen.findByTitle("Preview of Sales chart");
    // Still the same sandboxed frame on the content host. Framing it is what
    // keeps the document from navigating the tab away.
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("src")).toBe("http://127.0.0.1:5173/preview/token");
    // The masthead stays, so the account the artifact was opened under and the
    // way back out are both real application chrome, outside the frame.
    expect(screen.getByText("person@acme.example")).toBeDefined();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeDefined();
  });

  test("names the tab after the artifact, which is the only label it has", async () => {
    window.history.replaceState(null, "", "/a/artifact-1");
    stubFetch(signedIn);
    render(<App />);

    await screen.findByTitle("Preview of Sales chart");
    expect(document.title).toBe("Sales chart");
  });

  test("says so when the artifact cannot be loaded", async () => {
    window.history.replaceState(null, "", "/a/artifact-1");
    stubFetch((path) =>
      path === "/api/artifacts/artifact-1"
        ? { status: 404, body: { error: { code: "NOT_FOUND", message: "No such artifact." } } }
        : signedIn(path),
    );
    render(<App />);

    expect((await screen.findByRole("alert")).textContent).toContain("No such artifact.");
  });
});

describe("failures", () => {
  test("offers a retry when the server cannot be reached", async () => {
    stubFetchWith(() => Promise.reject(new Error("offline")));
    render(<App />);

    expect(await screen.findByRole("alert")).toBeDefined();
    expect(screen.getByRole("button", { name: "Try again" })).toBeDefined();
  });
});
