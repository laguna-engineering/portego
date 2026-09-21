import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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

    // The gallery lists it, and the search finds it.
    await page.getByRole("button", { name: "← All artifacts" }).click();
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
    // A card click opens the full-screen view, not the detail page.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height - 3);
    await page.waitForURL(`${app.server.origin}/a/${short}/full`);
  });

  test("keeps the masthead where it is when the artifact goes full screen", async () => {
    const id = await uploadArtifact(app, { title: "Steady header", html: SELF_CONTAINED_ARTIFACT });
    const context = await app.signedIn();
    const page = await context.newPage();
    await page.goto(`${app.server.origin}/a/${id}`);

    const masthead = page.getByRole("banner");
    const before = await masthead.boundingBox();

    await page.getByRole("link", { name: "Full screen" }).click();
    await page.waitForURL(`${app.server.origin}/a/${id}/full`);
    const after = await masthead.boundingBox();

    // A masthead that changed width or place would jump on every trip in and
    // out of the full-screen view.
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

  test("reads an artifact as text without rendering it", async () => {
    const id = await uploadArtifact(app, {
      title: "Readable",
      html: "<!doctype html><html><title>t</title><h1>A heading</h1><p>Some text.</p></html>",
    });

    const context = await app.signedIn();
    const page = await context.newPage();
    await page.goto(`${app.server.origin}/a/${id}`);

    await page.getByRole("tab", { name: "Text" }).click();
    await page.getByText("# A heading").waitFor();
  });

  test("marks an artifact solved and comments on it", async () => {
    const id = await uploadArtifact(app, { title: "A question", html: SELF_CONTAINED_ARTIFACT });

    const context = await app.signedIn();
    const page = await context.newPage();
    await page.goto(`${app.server.origin}/a/${id}`);

    await page.getByRole("button", { name: "Mark solved" }).click();
    await page.getByRole("button", { name: "Reopen" }).waitFor();

    await page.getByLabel("Add a comment").fill("Answered offline.");
    await page.getByRole("button", { name: "Comment" }).click();
    await page.getByText("Answered offline.").waitFor();
  });

  test("replies to a comment, and the reply stays with its thread", async () => {
    const id = await uploadArtifact(app, { title: "Threaded", html: SELF_CONTAINED_ARTIFACT });
    const context = await app.signedIn();
    const page = await context.newPage();
    await page.goto(`${app.server.origin}/a/${id}`);

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
    await page.goto(`${app.server.origin}/a/${id}/full`);

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

  test("comments on a passage selected inside the artifact", async () => {
    const id = await uploadArtifact(app, {
      title: "Annotated",
      html: "<!doctype html><html><head><title>t</title></head><body><p>First point.</p><p>Second point.</p></body></html>",
    });

    const context = await app.signedIn();
    const page = await context.newPage();
    await page.goto(`${app.server.origin}/a/${id}/full`);
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
        await watcher.getByText("No comments yet.").waitFor();

        await actor.getByLabel("Add a comment").fill("Written in the other browser");
        await actor.getByRole("button", { name: "Comment" }).click();

        await watcher.getByText("Written in the other browser").waitFor();
      });
    },
    TWO_BROWSERS_MS,
  );
});
