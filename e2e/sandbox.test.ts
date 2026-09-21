import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  HOSTILE_ARTIFACTS,
  SELF_CONTAINED_ARTIFACT,
} from "../src/server/preview/fixtures/hostile.ts";
import { type BrowserApp, recordRequests, startBrowserApp, uploadArtifact } from "./support.ts";

let app: BrowserApp;

beforeAll(async () => {
  app = await startBrowserApp();
});

afterEach(async () => {
  await app.closeContexts();
});

afterAll(async () => {
  await app.stop();
});

/** Opens an artifact's page and returns what its preview reported. */
async function preview(title: string, html: string) {
  const id = await uploadArtifact(app, { title, html });
  const context = await app.signedIn();
  const requests = recordRequests(context);
  const page = await context.newPage();

  await page.goto(`${app.server.origin}/a/${id}`);
  const frame = page.frameLocator(`iframe[title="Preview of ${title}"]`);
  await frame.locator("#outcome").waitFor();
  // Long enough for a network attempt or a promise rejection to land.
  await page.waitForTimeout(300);

  const reached = (host: string) => requests.answered.some((url) => url.includes(host));
  const refusedFor = (host: string) =>
    requests.refused.filter((entry) => entry.url.includes(host)).map((entry) => entry.reason);

  return {
    page,
    context,
    outcome: (await frame.locator("#outcome").textContent()) ?? "",
    requests,
    reached,
    refusedFor,
    reachedAttacker: reached("attacker.example"),
  };
}

describe("a self-contained artifact", () => {
  test("runs its own script and renders", async () => {
    const id = await uploadArtifact(app, { title: "Real one", html: SELF_CONTAINED_ARTIFACT });
    const context = await app.signedIn();
    const page = await context.newPage();

    await page.goto(`${app.server.origin}/a/${id}`);
    const frame = page.frameLocator('iframe[title="Preview of Real one"]');
    await frame.locator("#root").waitFor();
    expect(await frame.locator("#root").textContent()).toBe("rendered");
  });
});

describe("hostile artifacts", () => {
  test("cannot read the page framing them", async () => {
    const { outcome, page } = await preview(
      "parent dom",
      HOSTILE_ARTIFACTS["reads the parent DOM"] ?? "",
    );
    expect(outcome).toContain("BLOCKED");
    expect(await page.title()).not.toBe("taken");
  });

  test("see no cookies", async () => {
    const { outcome } = await preview("cookies", HOSTILE_ARTIFACTS["reads cookies"] ?? "");
    // An opaque origin has no cookie jar at all, so reading one throws.
    expect(outcome).toContain("BLOCKED");
  });

  test("cannot write to storage", async () => {
    const { outcome } = await preview("storage", HOSTILE_ARTIFACTS["reads local storage"] ?? "");
    expect(outcome).toContain("BLOCKED");
  });

  test("cannot call the application API", async () => {
    const { outcome, reached } = await preview(
      "api",
      HOSTILE_ARTIFACTS["calls the application API"] ?? "",
    );
    expect(outcome).toContain("BLOCKED");
    expect(reached("share.acme.example")).toBe(false);
  });

  test("cannot submit a form anywhere", async () => {
    const { reachedAttacker } = await preview("form", HOSTILE_ARTIFACTS["submits a form"] ?? "");
    expect(reachedAttacker).toBe(false);
  });

  test("cannot open a window", async () => {
    const { outcome, context } = await preview("window", HOSTILE_ARTIFACTS["opens a window"] ?? "");
    expect(outcome).toContain("BLOCKED");
    // One page: the one the test opened.
    expect(context.pages()).toHaveLength(1);
  });

  test("cannot navigate the page framing them", async () => {
    const { page } = await preview(
      "top navigation",
      HOSTILE_ARTIFACTS["navigates the top page"] ?? "",
    );
    expect(page.url()).toContain(app.server.origin);
    expect(page.url()).not.toContain("attacker.example");
  });

  test("cannot register a service worker", async () => {
    const { outcome } = await preview(
      "service worker",
      HOSTILE_ARTIFACTS["registers a service worker"] ?? "",
    );
    expect(outcome).toContain("BLOCKED");
  });

  test("cannot load a remote script", async () => {
    const { reachedAttacker, refusedFor } = await preview(
      "remote script",
      HOSTILE_ARTIFACTS["loads a remote script"] ?? "",
    );
    expect(reachedAttacker).toBe(false);
    // The browser names the policy that stopped it.
    expect(refusedFor("attacker.example")).toContain("csp");
  });

  test("cannot load a remote image", async () => {
    const { reachedAttacker, refusedFor } = await preview(
      "remote image",
      HOSTILE_ARTIFACTS["loads a remote image"] ?? "",
    );
    expect(reachedAttacker).toBe(false);
    expect(refusedFor("attacker.example")).toContain("csp");
  });

  test("cannot frame the application", async () => {
    const { reached } = await preview(
      "nested frame",
      HOSTILE_ARTIFACTS["frames another page"] ?? "",
    );
    expect(reached("share.acme.example")).toBe(false);
  });

  test("cannot point relative URLs somewhere else with a base element", async () => {
    const { reachedAttacker } = await preview(
      "base element",
      HOSTILE_ARTIFACTS["rewrites relative URLs with a base element"] ?? "",
    );
    expect(reachedAttacker).toBe(false);
  });
});

describe("opening an artifact full screen", () => {
  /** Clicks Full screen on the detail page and returns the page it lands on. */
  async function goFullScreen(title: string, html: string) {
    const id = await uploadArtifact(app, { title, html });
    const context = await app.signedIn();
    const requests = recordRequests(context);
    const page = await context.newPage();
    await page.goto(`${app.server.origin}/a/${id}`);

    await page.getByRole("link", { name: "Full screen" }).click();
    await page.waitForURL(`${app.server.origin}/a/${id}/full`);
    const frame = page.frameLocator(`iframe[title="Preview of ${title}"]`);
    return { id, page, context, requests, frame };
  }

  /** Opens a hostile document full screen and returns what it reported. */
  async function fullScreen(title: string, html: string) {
    const opening = await goFullScreen(title, html);
    await opening.frame.locator("#outcome").waitFor();
    // Long enough for a network attempt or a promise rejection to land.
    await opening.page.waitForTimeout(300);

    return {
      ...opening,
      outcome: (await opening.frame.locator("#outcome").textContent()) ?? "",
      reached: (host: string) => opening.requests.answered.some((url) => url.includes(host)),
      reachedAttacker: opening.requests.answered.some((url) => url.includes("attacker.example")),
    };
  }

  test("fills the tab under the masthead with the artifact", async () => {
    const { id, page, frame } = await goFullScreen("Full screen", SELF_CONTAINED_ARTIFACT);

    expect(page.url()).toBe(`${app.server.origin}/a/${id}/full`);
    await frame.locator("#root").waitFor();
    expect(await frame.locator("#root").textContent()).toBe("rendered");
    // The masthead is on the page, outside the frame the artifact runs in.
    expect(await page.getByRole("button", { name: "Sign out" }).count()).toBe(1);
  });

  test("gives the artifact no handle on the tab that opened it", async () => {
    const id = await uploadArtifact(app, { title: "No opener", html: SELF_CONTAINED_ARTIFACT });
    const context = await app.signedIn();
    const page = await context.newPage();
    await page.goto(`${app.server.origin}/a/${id}`);

    // The link carries no `target`, so a new tab is the reader's choice. `rel`
    // is what keeps the tab they choose from getting a handle on this one.
    const [opened] = await Promise.all([
      context.waitForEvent("page"),
      page.getByRole("link", { name: "Full screen" }).click({ modifiers: ["ControlOrMeta"] }),
    ]);
    await opened.waitForLoadState();

    expect(opened.url()).toBe(`${app.server.origin}/a/${id}/full`);
    expect(await opened.evaluate(() => window.opener === null)).toBe(true);
  });

  // A sandboxed document that is itself the top-level page can navigate its own
  // tab anywhere, and no response header prevents that. Framing the artifact
  // inside a page on the application origin is what keeps the restriction, so
  // the hostile documents are worth running again through this route.
  test("cannot navigate the tab it fills", async () => {
    const { page, id } = await fullScreen(
      "top navigation",
      HOSTILE_ARTIFACTS["navigates the top page"] ?? "",
    );
    expect(page.url()).toBe(`${app.server.origin}/a/${id}/full`);
  });

  test("still sees no cookies", async () => {
    const { outcome } = await fullScreen("cookies", HOSTILE_ARTIFACTS["reads cookies"] ?? "");
    expect(outcome).toContain("BLOCKED");
  });

  test("still cannot call the application API", async () => {
    const { outcome, reached } = await fullScreen(
      "api",
      HOSTILE_ARTIFACTS["calls the application API"] ?? "",
    );
    expect(outcome).toContain("BLOCKED");
    expect(reached("share.acme.example")).toBe(false);
  });

  test("still cannot open a window", async () => {
    const { outcome, context } = await fullScreen(
      "window",
      HOSTILE_ARTIFACTS["opens a window"] ?? "",
    );
    expect(outcome).toContain("BLOCKED");
    // One page: the tab the reader is on. The artifact added none.
    expect(context.pages()).toHaveLength(1);
  });

  test("still cannot submit a form anywhere", async () => {
    const { reachedAttacker } = await fullScreen("form", HOSTILE_ARTIFACTS["submits a form"] ?? "");
    expect(reachedAttacker).toBe(false);
  });

  test("still cannot read the page framing it", async () => {
    const { outcome, page } = await fullScreen(
      "parent dom",
      HOSTILE_ARTIFACTS["reads the parent DOM"] ?? "",
    );
    expect(outcome).toContain("BLOCKED");
    expect(await page.title()).not.toBe("taken");
  });
});

describe("preview links", () => {
  test("stop working once they expire", async () => {
    const id = await uploadArtifact(app, { title: "Expiring", html: SELF_CONTAINED_ARTIFACT });
    const context = await app.signedIn();
    const page = await context.newPage();
    await page.goto(`${app.server.origin}/a/${id}`);

    const source = await page.locator('iframe[title="Preview of Expiring"]').getAttribute("src");
    const expired = await context.newPage();
    // A token this deployment never issued is refused the same way an expired
    // one is.
    const response = await expired.goto(`${source?.split("/preview/")[0]}/preview/v1.YQ.99.forged`);
    expect(response?.status()).toBe(403);
  });

  test("do not work for another artifact", async () => {
    const first = await uploadArtifact(app, { title: "First", html: SELF_CONTAINED_ARTIFACT });
    const second = await uploadArtifact(app, { title: "Second", html: SELF_CONTAINED_ARTIFACT });

    const context = await app.signedIn();
    const page = await context.newPage();
    await page.goto(`${app.server.origin}/a/${first}`);
    const source = await page.locator('iframe[title="Preview of First"]').getAttribute("src");

    const swapped = `${source?.split("/preview/")[0]}/preview/${second}`;
    const other = await context.newPage();
    const response = await other.goto(swapped);
    expect(response?.status()).toBe(403);
  });
});
