import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { SELF_CONTAINED_ARTIFACT } from "../src/server/preview/fixtures/hostile.ts";
import { type BrowserApp, startBrowserApp, uploadArtifact } from "./support.ts";

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

describe("sign-in boundary", () => {
  test("shows a browser with no session the sign-in page and no artifacts", async () => {
    await uploadArtifact(app, { title: "Private chart", html: SELF_CONTAINED_ARTIFACT });

    const context = await app.anonymous();
    const page = await context.newPage();
    await page.goto(app.server.origin);

    await page.getByRole("button", { name: "Continue with Google" }).waitFor();
    expect(await page.getByText("Private chart").count()).toBe(0);
  });

  test("refuses a deep link to an artifact without a session", async () => {
    const id = await uploadArtifact(app, { title: "Deep link", html: SELF_CONTAINED_ARTIFACT });

    const context = await app.anonymous();
    const page = await context.newPage();
    await page.goto(`${app.server.origin}/a/${id}`);

    await page.getByRole("button", { name: "Continue with Google" }).waitFor();
    expect(await page.getByText("Deep link").count()).toBe(0);
  });
});

describe("the whole flow in a browser", () => {
  test("uploads a file, finds it in the gallery, opens it, and previews it safely", async () => {
    const context = await app.signedIn();
    const page = await context.newPage();
    await page.goto(app.server.origin);

    // Upload through the dialog, with a real file on disk.
    const file = join(mkdtempSync(join(tmpdir(), "e2e-")), "chart.html");
    writeFileSync(file, SELF_CONTAINED_ARTIFACT);

    await page.getByRole("main").getByRole("button", { name: "Upload" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    await dialog.locator('input[type="file"]').setInputFiles(file);
    await dialog.getByLabel("Title").fill("Quarterly chart");
    await dialog.getByLabel("Description (optional)").fill("Uploaded by a browser test");
    await dialog.getByRole("button", { name: "Upload" }).click();

    // The upload lands on the artifact's own page.
    await page.getByRole("heading", { name: "Quarterly chart" }).waitFor();
    expect(page.url()).toContain("/a/");

    // The preview runs the artifact's own script, from the content host.
    const frame = page.frameLocator('iframe[title="Preview of Quarterly chart"]');
    await frame.locator("#root").waitFor();
    expect(await frame.locator("#root").textContent()).toBe("rendered");

    const source = await page
      .locator('iframe[title="Preview of Quarterly chart"]')
      .getAttribute("src");
    expect(source?.startsWith(app.server.contentOrigin)).toBe(true);
    expect(source?.startsWith(app.server.origin)).toBe(false);

    // The wordmark leads back to the gallery, which lists it, and the search finds it.
    await page.getByRole("button", { name: "portego" }).click();
    await page.getByText("Quarterly chart").waitFor();

    await page.getByLabel("Search artifacts").fill("Quarterly");
    await page.getByText("Quarterly chart").waitFor();
    expect(page.url()).toContain("q=Quarterly");
  });

  test("opens a short card from the empty space its taller neighbour gives it", async () => {
    await uploadArtifact(app, {
      title: "Tall neighbour",
      html: SELF_CONTAINED_ARTIFACT,
      description: "A description long enough to wrap onto the second line this card allows, "
        .repeat(3)
        .trim(),
    });
    const short = await uploadArtifact(app, { title: "Short card", html: SELF_CONTAINED_ARTIFACT });

    const context = await app.signedIn();
    const page = await context.newPage();
    await page.goto(app.server.origin);

    const card = page.locator("li.card", { hasText: "Short card" });
    const box = await card.boundingBox();
    if (!box) throw new Error("The short card is not on the page.");

    // The bottom edge of the card, which is below where its own text ends.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height - 3);
    await page.waitForURL(`${app.server.origin}/a/${short}`);
  });

  test("keeps the masthead where it is when an artifact opens from the gallery", async () => {
    const id = await uploadArtifact(app, { title: "Steady header", html: SELF_CONTAINED_ARTIFACT });
    const context = await app.signedIn();
    const page = await context.newPage();
    await page.goto(app.server.origin);

    const masthead = page.getByRole("banner");
    const before = await masthead.boundingBox();

    await page.locator("li.card", { hasText: "Steady header" }).getByRole("link").click();
    await page.waitForURL(`${app.server.origin}/a/${id}`);
    const after = await masthead.boundingBox();

    // A masthead that changed width or place would jump on every trip between
    // the gallery and an artifact.
    expect(after).toEqual(before);
  });

  test("downloads the source as a file", async () => {
    const id = await uploadArtifact(app, {
      title: "Downloadable",
      html: SELF_CONTAINED_ARTIFACT,
    });

    const context = await app.signedIn();
    const page = await context.newPage();
    await page.goto(`${app.server.origin}/a/${id}`);

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("link", { name: "Download source" }).click(),
    ]);

    expect(download.suggestedFilename()).toBe("artifact.html");
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe(SELF_CONTAINED_ARTIFACT);
  });

  test("marks an artifact solved and comments on it", async () => {
    const id = await uploadArtifact(app, { title: "A question", html: SELF_CONTAINED_ARTIFACT });

    const context = await app.signedIn();
    const page = await context.newPage();
    await page.goto(`${app.server.origin}/a/${id}`);

    await page.getByRole("button", { name: "Mark solved" }).click();
    await page.getByRole("button", { name: "Reopen" }).waitFor();

    await page.getByRole("button", { name: "Versions & comments" }).click();
    await page.getByLabel("Add a comment").fill("Answered offline.");
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await page.getByText("Answered offline.").waitFor();
  });

  test("replies to a comment, and the reply stays with its thread", async () => {
    const id = await uploadArtifact(app, { title: "Threaded", html: SELF_CONTAINED_ARTIFACT });
    const context = await app.signedIn();
    const page = await context.newPage();
    await page.goto(`${app.server.origin}/a/${id}`);

    await page.getByRole("button", { name: "Versions & comments" }).click();
    await page.getByLabel("Add a comment").fill("Is the axis label right?");
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await page.getByText("Is the axis label right?").waitFor();

    // A reply is written under the comment it answers and appears there, so
    // a thread reads as one conversation rather than a list of loose remarks.
    await page.getByRole("button", { name: "Reply", exact: true }).click();
    await page.getByLabel(/^Reply to /).fill("Yes, it matches the source.");
    await page.getByRole("button", { name: "Reply", exact: true }).click();
    const reply = page.locator(".comment-replies").getByText("Yes, it matches the source.");
    await reply.waitFor();

    const stored = await page.evaluate(async (artifactId) => {
      const res = await fetch(`/api/artifacts/${artifactId}/comments`);
      return (await res.json()) as { comments: { id: string; parentId: string | null }[] };
    }, id);
    expect(stored.comments[1]?.parentId).toBe(stored.comments[0]?.id);

    await context.close();
  });

  test("marks an artifact solved and switches to markdown from the full-screen masthead", async () => {
    const id = await uploadArtifact(app, {
      title: "Full screen question",
      html: "<!doctype html><html><title>t</title><h1>A heading</h1><p>Some text.</p></html>",
    });

    const context = await app.signedIn();
    const page = await context.newPage();
    await page.goto(`${app.server.origin}/a/${id}`);

    await page.getByRole("button", { name: "Mark solved" }).click();
    await page.getByRole("button", { name: "Reopen" }).waitFor();

    await page.locator('iframe[title="Preview of Full screen question"]').waitFor();
    await page.getByRole("button", { name: "View markdown" }).click();
    await page.getByText("# A heading").waitFor();
    expect(await page.locator('iframe[title="Preview of Full screen question"]').count()).toBe(0);

    // Closed so its live-event stream does not count against the per-user
    // budget the two-browser tests below need.
    await context.close();
  });

  describe("full-screen masthead tooltips", () => {
    const CONTROLS = [
      { role: "button", name: "Copy link" },
      { role: "button", name: "Mark solved" },
      { role: "button", name: "Archive" },
      { role: "link", name: "Download source" },
      { role: "button", name: "View markdown" },
      { role: "button", name: "Versions & comments" },
    ] as const;

    const opacity = (element: Element) => getComputedStyle(element).opacity;

    async function openFullScreen(title: string) {
      const id = await uploadArtifact(app, { title, html: SELF_CONTAINED_ARTIFACT });
      const context = await app.signedIn();
      const page = await context.newPage();
      await page.goto(`${app.server.origin}/a/${id}`);
      await page.getByRole("button", { name: "Copy link" }).waitFor();
      return { context, page };
    }

    test("names each icon-only control below it while the pointer is on it", async () => {
      const { context, page } = await openFullScreen("Tooltips on hover");

      for (const { role, name } of CONTROLS) {
        const control = page.getByRole(role, { name });
        const label = control.locator("span");
        expect(await label.evaluate(opacity)).toBe("0");

        await control.hover();
        expect(await label.evaluate(opacity)).toBe("1");
        expect(await label.innerText()).toBe(name);

        // Below the control, so it never covers the icon it explains.
        const controlBox = await control.boundingBox();
        const labelBox = await label.boundingBox();
        if (!controlBox || !labelBox) throw new Error(`${name} has no box`);
        expect(labelBox.y).toBeGreaterThanOrEqual(controlBox.y + controlBox.height);
      }

      // One label at a time: the last control keeps the pointer.
      expect(
        await page.getByRole("button", { name: "Copy link" }).locator("span").evaluate(opacity),
      ).toBe("0");

      await context.close();
    });

    test("names a control reached with the keyboard", async () => {
      const { context, page } = await openFullScreen("Tooltips on focus");
      const control = page.getByRole("button", { name: "Copy link" });

      for (let presses = 0; presses < 10; presses++) {
        await page.keyboard.press("Tab");
        if (await control.evaluate((element) => element === document.activeElement)) break;
      }

      expect(await control.locator("span").evaluate(opacity)).toBe("1");

      await context.close();
    });

    test("confirms a copied link in the tooltip, the only place the label shows", async () => {
      const { context, page } = await openFullScreen("Tooltip after copy");
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);

      await page.getByRole("button", { name: "Copy link" }).click();

      const copied = page.getByRole("button", { name: "Link copied" });
      await copied.waitFor();
      expect(await copied.locator("span").evaluate(opacity)).toBe("1");

      await context.close();
    });
  });

  describe("full-screen masthead on a phone", () => {
    const CONTROLS = [
      { role: "button", name: "Copy link" },
      { role: "button", name: "Mark solved" },
      { role: "button", name: "Archive" },
      { role: "link", name: "Download source" },
      { role: "button", name: "View markdown" },
      { role: "button", name: "Versions & comments" },
    ] as const;

    async function openOnPhone(title: string) {
      const id = await uploadArtifact(app, { title, html: SELF_CONTAINED_ARTIFACT });
      const context = await app.signedIn();
      const page = await context.newPage();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${app.server.origin}/a/${id}`);
      await page.getByRole("button", { name: "Menu" }).waitFor();
      return { context, page };
    }

    test("hides the desktop controls and account block behind a closed toggle", async () => {
      const { context, page } = await openOnPhone("Phone masthead closed");

      const toggle = page.getByRole("button", { name: "Menu" });
      expect(await toggle.getAttribute("aria-expanded")).toBe("false");

      for (const { role, name } of CONTROLS) {
        expect(await page.getByRole(role, { name }).count()).toBe(0);
      }
      expect(await page.getByRole("button", { name: "Sign out" }).count()).toBe(0);

      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth).toBeLessThanOrEqual(390);

      await context.close();
    });

    test("shows every action as a visible, labelled row when the menu opens", async () => {
      const { context, page } = await openOnPhone("Phone masthead open");
      await page.getByRole("button", { name: "Menu" }).click();

      const menu = page.locator(".masthead-menu");
      await menu.waitFor();

      for (const { role, name } of CONTROLS) {
        const row = menu.getByRole(role, { name });
        expect(await row.isVisible()).toBe(true);
        expect(await row.innerText()).toContain(name);
      }

      const download = menu.getByRole("link", { name: "Download source" });
      expect(await download.getAttribute("href")).toMatch(/\/api\/artifacts\/.+\/source$/);
      expect(await download.getAttribute("download")).not.toBeNull();

      expect(await menu.getByText("person@acme.example").isVisible()).toBe(true);
      expect(await menu.getByRole("button", { name: "Sign out" }).isVisible()).toBe(true);

      const toggle = page.getByRole("button", { name: "Close menu" });
      expect(await toggle.getAttribute("aria-expanded")).toBe("true");

      await context.close();
    });

    test("closes the menu with the toggle, Escape, or the backdrop", async () => {
      const { context, page } = await openOnPhone("Phone masthead closing");
      const toggle = page.getByRole("button", { name: "Menu" });
      const menu = page.locator(".masthead-menu");

      await toggle.click();
      await menu.waitFor();
      await page.getByRole("button", { name: "Close menu" }).click();
      expect(await menu.count()).toBe(0);

      await toggle.click();
      await menu.waitFor();
      await page.keyboard.press("Escape");
      expect(await menu.count()).toBe(0);

      await toggle.click();
      await menu.waitFor();
      // The panel covers the backdrop's upper part, so only a point low in
      // the viewport reaches the backdrop rather than a row inside the panel.
      await page.locator(".masthead-menu-backdrop").click({ position: { x: 195, y: 800 } });
      expect(await menu.count()).toBe(0);

      await context.close();
    });

    test("confirms a copied link without closing the menu", async () => {
      const { context, page } = await openOnPhone("Phone masthead copy link");
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);

      await page.getByRole("button", { name: "Menu" }).click();
      const menu = page.locator(".masthead-menu");
      await menu.getByRole("button", { name: "Copy link" }).click();

      await menu.getByRole("button", { name: "Link copied" }).waitFor();
      expect(await menu.isVisible()).toBe(true);

      await context.close();
    });

    test("marks an artifact solved from the menu", async () => {
      const { context, page } = await openOnPhone("Phone masthead solved");
      const menu = page.locator(".masthead-menu");

      await page.getByRole("button", { name: "Menu" }).click();
      await menu.getByRole("button", { name: "Mark solved" }).click();
      expect(await menu.count()).toBe(0);

      await page.getByRole("button", { name: "Menu" }).click();
      await menu.getByRole("button", { name: "Reopen" }).waitFor();
      expect(await page.locator(".full-title .badge.solved").count()).toBe(1);

      await context.close();
    });

    test("switches to markdown and opens comments from the menu", async () => {
      const id = await uploadArtifact(app, {
        title: "Phone masthead markdown",
        html: "<!doctype html><html><title>t</title><h1>A heading</h1><p>Some text.</p></html>",
      });
      const context = await app.signedIn();
      const page = await context.newPage();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${app.server.origin}/a/${id}`);
      const menu = page.locator(".masthead-menu");

      await page.getByRole("button", { name: "Menu" }).waitFor();
      await page.getByRole("button", { name: "Menu" }).click();
      await menu.getByRole("button", { name: "View markdown" }).click();
      await page.getByText("# A heading").waitFor();
      expect(await menu.count()).toBe(0);

      await page.getByRole("button", { name: "Menu" }).click();
      await menu.getByRole("button", { name: "Versions & comments" }).click();
      await page.getByRole("dialog", { name: "Comments" }).waitFor();
      expect(await menu.count()).toBe(0);

      await context.close();
    });

    test("keeps a long title on one line and hides secondary metadata", async () => {
      const { context, page } = await openOnPhone(
        "A very long title that would ordinarily wrap onto more than one line on a narrow phone screen",
      );

      const heading = page.locator(".full-title h1");
      const box = await heading.boundingBox();
      if (!box) throw new Error("The title has no box");
      expect(box.height).toBeLessThan(40);

      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth).toBeLessThanOrEqual(390);
      expect(await page.locator(".full-title .meta-extra").isVisible()).toBe(false);

      await context.close();
    });

    test("does not show the phone menu toggle at a desktop width", async () => {
      const id = await uploadArtifact(app, {
        title: "Desktop masthead",
        html: SELF_CONTAINED_ARTIFACT,
      });
      const context = await app.signedIn();
      const page = await context.newPage();
      await page.goto(`${app.server.origin}/a/${id}`);
      await page.getByRole("button", { name: "Copy link" }).waitFor();

      expect(await page.getByRole("button", { name: "Menu" }).count()).toBe(0);

      await context.close();
    });
  });

  describe("gallery on a phone", () => {
    async function openOnPhone() {
      const context = await app.signedIn();
      const page = await context.newPage();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(app.server.origin);
      await page.getByRole("button", { name: "Menu" }).waitFor();
      return { context, page };
    }

    test("hides the account block and the main Upload button behind a closed toggle", async () => {
      const { context, page } = await openOnPhone();

      const toggle = page.getByRole("button", { name: "Menu" });
      expect(await toggle.getAttribute("aria-expanded")).toBe("false");

      const mainUpload = page
        .getByRole("main")
        .getByRole("button", { name: "Upload", exact: true });
      expect(await mainUpload.count()).toBe(0);
      expect(await page.getByText("person@acme.example").isVisible()).toBe(false);

      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth).toBeLessThanOrEqual(390);

      await context.close();
    });

    test("opens a menu with Upload an artifact, the account email, and sign out", async () => {
      const { context, page } = await openOnPhone();

      await page.getByRole("button", { name: "Menu" }).click();
      const menu = page.locator(".masthead-menu");
      await menu.waitFor();

      await menu.getByRole("button", { name: "Upload an artifact" }).waitFor();
      expect(await menu.getByText("person@acme.example").isVisible()).toBe(true);
      expect(await menu.getByRole("button", { name: "Sign out" }).isVisible()).toBe(true);

      const toggle = page.getByRole("button", { name: "Close menu" });
      expect(await toggle.getAttribute("aria-expanded")).toBe("true");

      await context.close();
    });

    test("opens the upload dialog from the menu and closes the menu first", async () => {
      const { context, page } = await openOnPhone();

      await page.getByRole("button", { name: "Menu" }).click();
      const menu = page.locator(".masthead-menu");
      await menu.getByRole("button", { name: "Upload an artifact" }).click();
      expect(await menu.count()).toBe(0);

      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      await dialog.getByLabel("Title").waitFor();

      await context.close();
    });

    test("signs out from the menu", async () => {
      const { context, page } = await openOnPhone();

      await page.getByRole("button", { name: "Menu" }).click();
      const menu = page.locator(".masthead-menu");
      await menu.getByRole("button", { name: "Sign out" }).click();

      await page.getByRole("button", { name: "Continue with Google" }).waitFor();

      await context.close();
    });

    test("lays out the search field, status chips, sort, and archived toggle", async () => {
      const { context, page } = await openOnPhone();

      const searchBox = await page.getByLabel("Search artifacts").boundingBox();
      if (!searchBox) throw new Error("The search field has no box");
      expect(searchBox.width).toBeGreaterThanOrEqual(340);

      const chipBoxes: { y: number; height: number }[] = [];
      for (const name of ["All", "Open", "Solved"]) {
        const box = await page.getByRole("button", { name }).boundingBox();
        if (!box) throw new Error(`The ${name} chip has no box`);
        chipBoxes.push(box);
      }
      const chipsBottom = Math.max(...chipBoxes.map((box) => box.y + box.height));

      const sortBox = await page.getByLabel("Sort by").boundingBox();
      const archivedBox = await page.getByLabel("Show archived").boundingBox();
      if (!sortBox || !archivedBox) throw new Error("The sort or archived control has no box");

      expect(chipsBottom).toBeLessThanOrEqual(sortBox.y);
      expect(chipsBottom).toBeLessThanOrEqual(archivedBox.y);

      // On the same row: their vertical ranges overlap.
      expect(sortBox.y).toBeLessThan(archivedBox.y + archivedBox.height);
      expect(archivedBox.y).toBeLessThan(sortBox.y + sortBox.height);

      expect(sortBox.x + sortBox.width).toBeLessThanOrEqual(390);
      expect(archivedBox.x + archivedBox.width).toBeLessThanOrEqual(390);

      await context.close();
    });

    test("changes the URL on another sort and marks Solved pressed", async () => {
      const { context, page } = await openOnPhone();

      await page.getByLabel("Sort by").selectOption("created-asc");
      expect(page.url()).toContain("sort=created-asc");

      const solved = page.getByRole("button", { name: "Solved" });
      await solved.click();
      expect(await solved.getAttribute("aria-pressed")).toBe("true");

      await context.close();
    });

    test("lays out cards in one column at full width with no overflow", async () => {
      await uploadArtifact(app, { title: "Phone column left", html: SELF_CONTAINED_ARTIFACT });
      await uploadArtifact(app, { title: "Phone column right", html: SELF_CONTAINED_ARTIFACT });
      const { context, page } = await openOnPhone();

      const first = await page.locator("li.card", { hasText: "Phone column left" }).boundingBox();
      const second = await page.locator("li.card", { hasText: "Phone column right" }).boundingBox();
      if (!first || !second) throw new Error("A card has no box");

      expect(second.x).toBe(first.x);
      expect(second.width).toBe(first.width);
      expect(first.width).toBeGreaterThanOrEqual(340);

      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth).toBeLessThanOrEqual(390);

      await context.close();
    });

    test("shows the menu without Upload an artifact on the artifact detail page", async () => {
      const id = await uploadArtifact(app, {
        title: "Phone detail menu",
        html: SELF_CONTAINED_ARTIFACT,
      });
      const context = await app.signedIn();
      const page = await context.newPage();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${app.server.origin}/a/${id}`);
      await page.getByRole("button", { name: "Menu" }).waitFor();

      await page.getByRole("button", { name: "Menu" }).click();
      const menu = page.locator(".masthead-menu");
      await menu.waitFor();

      expect(await menu.getByRole("button", { name: "Upload an artifact" }).count()).toBe(0);
      expect(await menu.getByRole("button", { name: "Sign out" }).isVisible()).toBe(true);

      await context.close();
    });

    test("shows no menu toggle and a visible Upload button at a desktop width", async () => {
      const context = await app.signedIn();
      const page = await context.newPage();
      await page.goto(app.server.origin);
      await page.getByRole("main").getByRole("button", { name: "Upload" }).waitFor();

      expect(await page.getByRole("button", { name: "Menu" }).count()).toBe(0);

      await context.close();
    });
  });

  test("comments on a passage selected inside the artifact", async () => {
    const id = await uploadArtifact(app, {
      title: "Annotated",
      html: "<!doctype html><html><head><title>t</title></head><body><p>First point.</p><p>Second point.</p></body></html>",
    });

    const context = await app.signedIn();
    const page = await context.newPage();
    await page.goto(`${app.server.origin}/a/${id}`);
    const frame = page.frameLocator('iframe[title="Preview of Annotated"]');
    await frame.locator("p").first().waitFor();

    // A selection in the frame reaches the page through the bridge, with a
    // control beside it. That control opens the panel with the quote pending.
    await frame.locator("body").evaluate((body) => {
      const second = body.querySelectorAll("p")[1];
      if (!second) throw new Error("no second paragraph");
      document.getSelection()?.selectAllChildren(second);
    });
    await page.getByRole("button", { name: "Comment on selection" }).click();
    const panel = page.getByRole("dialog", { name: "Comments" });
    await panel.waitFor();
    await panel.getByText("Second point.").waitFor();

    await panel.getByLabel("Add a comment").fill("Not sure about this one.");
    await panel.getByRole("button", { name: "Comment", exact: true }).click();
    await panel.getByText("Not sure about this one.").waitFor();

    // The stored comment carries the passage, and the frame paints it.
    const stored = await page.evaluate(async (artifactId) => {
      const res = await fetch(`/api/artifacts/${artifactId}/comments`);
      return (await res.json()) as { comments: { anchor: { quote: string } | null }[] };
    }, id);
    expect(stored.comments[0]?.anchor?.quote).toBe("Second point.");
    const painted = async () =>
      frame.locator("body").evaluate(() => CSS.highlights.get("portego-comment")?.size ?? 0);
    const deadline = Date.now() + 5000;
    while ((await painted()) !== 1 && Date.now() < deadline) await page.waitForTimeout(100);
    expect(await painted()).toBe(1);

    await context.close();
  });
});

/**
 * The point of the change stream. Each of these keeps two browsers open and
 * never reloads the second one: what it shows has to arrive on its own.
 *
 * Signing in twice and opening two browser contexts takes longer than the
 * default budget for a single test, so each one states its own. Each also
 * closes the contexts it opened: a signed-in page holds a stream for as long
 * as it is open, and the server allows one user only so many at once.
 */
const TWO_BROWSERS_MS = 20_000;

describe("changes reach a page that is already open", () => {
  /** Opens signed-in pages and closes them, whatever the test does. */
  async function withPages(count: number, run: (pages: Page[]) => Promise<void>) {
    const contexts = await Promise.all(Array.from({ length: count }, () => app.signedIn()));
    try {
      await run(await Promise.all(contexts.map((context) => context.newPage())));
    } finally {
      for (const context of contexts) await context.close();
    }
  }

  test(
    "an upload appears in a gallery somebody else is looking at",
    async () => {
      await withPages(1, async ([watcher]) => {
        await watcher.goto(app.server.origin);
        await watcher.getByRole("main").getByRole("button", { name: "Upload" }).waitFor();

        await uploadArtifact(app, { title: "Arrived by itself", html: SELF_CONTAINED_ARTIFACT });

        await watcher.getByText("Arrived by itself").waitFor();
      });
    },
    TWO_BROWSERS_MS,
  );

  test(
    "a status change one person makes shows on the other person's page",
    async () => {
      const id = await uploadArtifact(app, {
        title: "Shared status",
        html: SELF_CONTAINED_ARTIFACT,
      });

      await withPages(2, async ([actor, watcher]) => {
        await actor.goto(`${app.server.origin}/a/${id}`);
        await watcher.goto(`${app.server.origin}/a/${id}`);
        await watcher.getByRole("button", { name: "Mark solved" }).waitFor();

        await actor.getByRole("button", { name: "Mark solved" }).click();

        await watcher.getByRole("button", { name: "Reopen" }).waitFor();
        expect(await watcher.getByText("solved").count()).toBeGreaterThan(0);
      });
    },
    TWO_BROWSERS_MS,
  );

  test(
    "a comment one person writes appears in the other person's thread",
    async () => {
      const id = await uploadArtifact(app, {
        title: "Shared thread",
        html: SELF_CONTAINED_ARTIFACT,
      });

      await withPages(2, async ([actor, watcher]) => {
        await actor.goto(`${app.server.origin}/a/${id}`);
        await watcher.goto(`${app.server.origin}/a/${id}`);
        for (const page of [actor, watcher]) {
          await page.getByRole("button", { name: "Versions & comments" }).click();
        }
        await watcher.getByText("No comments yet.").waitFor();

        await actor.getByLabel("Add a comment").fill("Written in the other browser");
        await actor.getByRole("button", { name: "Comment", exact: true }).click();

        await watcher.getByText("Written in the other browser").waitFor();
      });
    },
    TWO_BROWSERS_MS,
  );
});
