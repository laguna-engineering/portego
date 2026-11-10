import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { agentKey, enroll, poll } from "../src/server/service-accounts/testing.ts";
import { WORKSPACE_USER } from "../src/server/testing.ts";
import { type BrowserApp, startBrowserApp } from "./support.ts";

let app: BrowserApp;

beforeAll(async () => {
  app = await startBrowserApp({ serviceAccounts: true, admins: [WORKSPACE_USER.email] });
});

afterEach(async () => {
  await app.closeContexts();
});

afterAll(async () => {
  await app.stop();
});

describe("approving an agent in the browser", () => {
  // The URL the agent prints is the entry to the whole flow. It is a deep link
  // into the client, served by the catch-all route.
  test("an admin opens the agent's link, checks the code, and approves", async () => {
    const key = await agentKey();
    const enrollment = (await (await enroll(app.server, key, "Nightly digest")).json()) as {
      id: string;
      userCode: string;
      approvalUrl: string;
    };

    const page = await (await app.signedIn()).newPage();
    await page.goto(enrollment.approvalUrl);
    await page.getByRole("heading", { name: "Approve Nightly digest" }).waitFor();
    const code = `${enrollment.userCode.slice(0, 4)}-${enrollment.userCode.slice(4)}`;
    expect(await page.getByText(code).count()).toBe(1);

    await page.getByRole("button", { name: "Approve" }).click();
    await page.getByRole("heading", { name: "Approved" }).waitFor();
    const polled = (await (await poll(app.server, enrollment.id, key.privateKey)).json()) as {
      status: string;
    };
    expect(polled.status).toBe("approved");

    await page.getByRole("button", { name: "See all service accounts" }).click();
    await page.getByRole("heading", { name: "Service accounts" }).waitFor();
    // The heading renders before the list loads.
    const row = page.getByRole("row", { name: /Nightly digest/ });
    await row.getByText("Active").waitFor();

    page.once("dialog", (dialog) => void dialog.accept());
    await row.getByRole("button", { name: "Disable" }).click();
    await row.getByText("Disabled").waitFor();
  });
});
