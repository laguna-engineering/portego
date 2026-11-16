import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "playwright";
import { WORKSPACE_USER } from "../src/server/testing.ts";
import { type BrowserApp, startBrowserApp } from "./support.ts";

let app: BrowserApp;

beforeAll(async () => {
  app = await startBrowserApp({ teams: true, admins: [WORKSPACE_USER.email ?? ""] });
});

afterEach(async () => {
  await app.closeContexts();
});

afterAll(async () => {
  await app.stop();
});

async function scrollsSideways(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
}

describe("managing teams in the browser", () => {
  test("an admin creates a team, restricts a folder to it, and invites a guest", async () => {
    const page = await (await app.signedIn()).newPage();
    const admin = app.server.database
      .query('select id from "user" where email = ?')
      .get(WORKSPACE_USER.email ?? "") as { id: string };
    app.server.organization.createFolder({ name: "Contracts", actorId: admin.id });
    // A long name widens the folder list, which must still fit a phone.
    app.server.organization.createFolder({
      name: "Quarterly planning documents for the leadership offsite",
      actorId: admin.id,
    });

    await page.goto(`${app.server.origin}/settings/teams`);
    await page.getByRole("heading", { name: "Teams" }).waitFor();
    await page.getByLabel("New team").fill("Legal");
    await page.getByRole("button", { name: "Create team" }).click();
    const card = page.getByRole("article", { name: "Legal" });
    await card.waitFor();

    await card.getByLabel("Restrict a folder to Legal").selectOption({ label: "Contracts" });
    page.once("dialog", (dialog) => void dialog.accept());
    await card.getByRole("button", { name: "Restrict" }).click();
    await card.getByRole("listitem").filter({ hasText: "Contracts" }).waitFor();

    await page.setViewportSize({ width: 375, height: 800 });
    expect(await scrollsSideways(page)).toBe(false);
    await page.setViewportSize({ width: 1280, height: 800 });

    await page.goto(`${app.server.origin}/settings/invitations`);
    await page.getByLabel("Email address").fill("guest@partner.example");
    await page.getByLabel("Legal").check();
    await page.getByRole("button", { name: "Invite" }).click();
    await page
      .getByRole("row", { name: /guest@partner\.example/ })
      .getByText("Open")
      .waitFor();

    await page.setViewportSize({ width: 375, height: 800 });
    expect(await scrollsSideways(page)).toBe(false);

    // The admin is not in Legal, and admins do not bypass teams.
    const folders = (await (await page.request.get(`${app.server.origin}/api/folders`)).json()) as {
      folders: { name: string }[];
    };
    expect(folders.folders.map((folder) => folder.name)).toEqual([
      "Quarterly planning documents for the leadership offsite",
    ]);
  });
});
