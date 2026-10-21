import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { type BrowserApp, startBrowserApp, uploadArtifact } from "./support.ts";

let app: BrowserApp;

beforeAll(async () => {
  app = await startBrowserApp({ publicLinks: true });
});

afterEach(async () => {
  await app.closeContexts();
});

afterAll(async () => {
  await app.stop();
});

const SCHEMA = {
  keys: { "vote:{item}": { params: { item: { enum: ["P-01"] } }, value: { const: true } } },
};

const POLL = `<!doctype html><html><head><title>Poll</title>
<script type="application/json" id="portego-entries">${JSON.stringify(SCHEMA)}</script>
</head><body><button id="vote">Vote</button><p id="voters">waiting</p>
<script>
  window.addEventListener("portego:entries", (event) => {
    document.getElementById("voters").textContent =
      "Voters: " + event.detail.map((entry) => entry.author).join(", ");
  });
  document.getElementById("vote").addEventListener("click", () => window.portego.set("vote:P-01", true));
</script></body></html>`;

describe("a public link", () => {
  test("opens the artifact without a session, takes a named vote, and stops when revoked", async () => {
    const id = await uploadArtifact(app, { title: "Poll", html: POLL });

    const creator = await (await app.signedIn()).newPage();
    await creator.goto(`${app.server.origin}/a/${id}`);
    await creator.getByRole("button", { name: "Share" }).click();
    await creator.getByRole("button", { name: /Anyone with the link/ }).click();
    await creator.waitForFunction(() =>
      document
        .querySelector<HTMLInputElement>('input[aria-label="Public link"]')
        ?.value.includes("/s/"),
    );
    const link = await creator.getByRole("textbox", { name: "Public link" }).inputValue();
    expect(link.startsWith(`${app.server.origin}/s/`)).toBe(true);

    const outsider = await (await app.anonymous()).newPage();
    await outsider.goto(link);
    await outsider.getByRole("heading", { name: "Poll" }).waitFor();
    const frame = outsider.frameLocator('iframe[title="Preview of Poll"]');
    await frame.getByText("Voters:").waitFor();

    await frame.getByRole("button", { name: "Vote" }).click();
    await outsider.getByRole("textbox", { name: "Your name" }).fill("Dana");
    await outsider.getByRole("button", { name: "Continue" }).click();
    await frame.getByText("Voters: Dana (guest)").waitFor();

    await creator.getByRole("button", { name: "Revoke link" }).click();
    await creator.getByRole("button", { name: /Everyone signed in/, pressed: true }).waitFor();
    await outsider.reload();
    await outsider.getByRole("heading", { name: "This link does not work" }).waitFor();
  });
});
