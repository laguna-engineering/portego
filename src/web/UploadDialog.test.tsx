import { afterEach, describe, expect, test } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Artifact } from "./api.ts";
import { artifact, htmlFile, restoreFetch, stubFetch, stubFetchWith } from "./testing.ts";
import { UploadDialog } from "./UploadDialog.tsx";

afterEach(restoreFetch);

const LIMIT = 5 * 1024 * 1024;

function renderDialog(
  options: {
    onUploaded?: (uploaded: ReturnType<typeof artifact>) => void;
    onClose?: () => void;
    maxUploadBytes?: number;
  } = {},
) {
  return render(
    <UploadDialog
      maxUploadBytes={options.maxUploadBytes ?? LIMIT}
      onClose={options.onClose ?? (() => {})}
      onUploaded={options.onUploaded ?? (() => {})}
    />,
  );
}

function fileInput(): HTMLInputElement {
  const input = document.querySelector('input[type="file"]');
  if (!input) throw new Error("The dialog has no file input");
  return input as HTMLInputElement;
}

describe("choosing a file", () => {
  test("confirms the file and its size before anything is sent", async () => {
    renderDialog();
    await userEvent.upload(fileInput(), htmlFile("chart.html", 2048));

    expect(screen.getByText(/chart.html/)).toBeDefined();
    expect(screen.getByText(/2 KiB/)).toBeDefined();
  });

  test("refuses a file over the limit, and says both sizes", async () => {
    renderDialog({ maxUploadBytes: 1024 });
    await userEvent.upload(fileInput(), htmlFile("big.html", 4096));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("4 KiB");
    expect(alert.textContent).toContain("1 KiB");
  });

  test("refuses a file that is not HTML, before the server has to", async () => {
    renderDialog();
    // applyAccept is off because the point of the test is the check this
    // component makes, not the one the file picker makes.
    await userEvent.upload(fileInput(), new File(["id,name"], "report.csv", { type: "text/csv" }), {
      applyAccept: false,
    });

    expect((await screen.findByRole("alert")).textContent).toContain(".html");
  });

  test("keeps the upload button unusable until a file is chosen", async () => {
    renderDialog();
    const upload = screen.getByRole("button", { name: "Upload" }) as HTMLButtonElement;
    expect(upload.disabled).toBe(true);

    await userEvent.upload(fileInput(), htmlFile());
    expect((screen.getByRole("button", { name: "Upload" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});

describe("uploading", () => {
  test("reports the artifact it created", async () => {
    const created = artifact({ id: "new-artifact" });
    stubFetch(() => ({ status: 201, body: { artifact: created } }));

    const uploaded: Artifact[] = [];
    renderDialog({ onUploaded: (result) => uploaded.push(result) });

    await userEvent.upload(fileInput(), htmlFile());
    await userEvent.click(screen.getByRole("button", { name: "Upload" }));

    await waitFor(() => expect(uploaded).toHaveLength(1));
    expect(uploaded[0]?.id).toBe("new-artifact");
  });

  test("shows the upload in progress and stops a second submission", async () => {
    const held = Promise.withResolvers<void>();
    stubFetchWith(async () => {
      await held.promise;
      return new Response(JSON.stringify({ artifact: artifact() }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });

    renderDialog();
    await userEvent.upload(fileInput(), htmlFile("chart.html"));
    await userEvent.click(screen.getByRole("button", { name: "Upload" }));

    const button = await screen.findByRole("button", { name: /Uploading chart.html/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    held.resolve();
  });

  test("keeps the form usable after the server refuses the file", async () => {
    stubFetch(() => ({
      status: 400,
      body: { error: { code: "TITLE_REQUIRED", message: "Give the artifact a title." } },
    }));
    renderDialog();

    await userEvent.upload(fileInput(), htmlFile());
    await userEvent.click(screen.getByRole("button", { name: "Upload" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Give the artifact a title.");
    expect((screen.getByRole("button", { name: "Upload" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});

describe("closing", () => {
  test("closes on Escape, which is what a keyboard user reaches for", async () => {
    let closed = false;
    renderDialog({ onClose: () => (closed = true) });

    await userEvent.keyboard("{Escape}");
    expect(closed).toBe(true);
  });

  test("closes from the Cancel button", async () => {
    let closed = false;
    renderDialog({ onClose: () => (closed = true) });

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(closed).toBe(true);
  });

  test("keeps Tab inside the dialog, so focus cannot land behind it", async () => {
    renderDialog();
    const dialog = screen.getByRole("dialog");

    for (let press = 0; press < 12; press += 1) {
      await userEvent.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  test("returns focus to whatever opened it", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();

    const { unmount } = renderDialog();
    expect(document.activeElement).not.toBe(opener);

    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  test("names itself for a screen reader", () => {
    renderDialog();
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByRole("heading", { name: "Upload an artifact" })).toBeDefined();
  });
});
