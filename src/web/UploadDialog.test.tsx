import { afterEach, describe, expect, test } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Artifact, Folder } from "./api.ts";
import { artifact, htmlFile, restoreFetch, stubFetch, stubFetchWith } from "./testing.ts";
import { UploadDialog } from "./UploadDialog.tsx";

afterEach(restoreFetch);

const LIMIT = 5 * 1024 * 1024;

function renderDialog(
  options: {
    onUploaded?: (uploaded: ReturnType<typeof artifact>) => void;
    onClose?: () => void;
    maxUploadBytes?: number;
    initialFolderId?: string | null;
  } = {},
) {
  return render(
    <UploadDialog
      maxUploadBytes={options.maxUploadBytes ?? LIMIT}
      initialFolderId={options.initialFolderId ?? null}
      onClose={options.onClose ?? (() => {})}
      onUploaded={options.onUploaded ?? (() => {})}
    />,
  );
}

const REPORTS: Folder = { id: "reports", name: "Reports", parentId: null, artifactCount: 0 };
const WEEKLY: Folder = { id: "weekly", name: "Weekly", parentId: "reports", artifactCount: 0 };

/**
 * Answers the folder list and creates folders, recording each name in
 * `createdFolders`. Records every upload before `upload` answers it.
 */
function stubUploads(
  sent: FormData[],
  upload: (count: number) => { status?: number; body?: unknown },
  folders: Folder[] = [REPORTS, WEEKLY],
  createdFolders: string[] = [],
) {
  stubFetch((path, init) => {
    if (path === "/api/folders" && init?.method === "POST") {
      const { name } = JSON.parse(String(init.body)) as { name: string };
      createdFolders.push(name);
      return {
        status: 201,
        body: { folder: { id: "created-folder", name, parentId: null, artifactCount: 0 } },
      };
    }
    if (path === "/api/folders") return { body: { folders } };
    sent.push(init?.body as FormData);
    return upload(sent.length);
  });
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
    stubUploads([], () => ({ status: 201, body: { artifact: created } }));

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
    stubUploads([], () => ({
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

describe("a title another artifact already has", () => {
  // The first upload is refused; the second is the one the person chose.
  function stubTitleConflict(sent: FormData[]) {
    stubUploads(sent, (count) =>
      count === 1
        ? {
            status: 409,
            body: {
              error: { code: "TITLE_EXISTS", message: "Taken.", artifactId: "existing-artifact" },
            },
          }
        : { status: 201, body: { artifact: artifact({ id: "existing-artifact" }) } },
    );
  }

  test("adds a new version only after the person chooses it", async () => {
    const sent: FormData[] = [];
    stubTitleConflict(sent);
    const uploaded: Artifact[] = [];
    renderDialog({ onUploaded: (result) => uploaded.push(result) });

    await userEvent.upload(fileInput(), htmlFile());
    await userEvent.click(screen.getByRole("button", { name: "Upload" }));
    await userEvent.click(await screen.findByRole("button", { name: "Add as a new version" }));

    await waitFor(() => expect(uploaded).toHaveLength(1));
    expect(sent[0]?.get("artifactId")).toBeNull();
    expect(sent[1]?.get("artifactId")).toBe("existing-artifact");
  });

  test("uploads a separate artifact when the person chooses that", async () => {
    const sent: FormData[] = [];
    stubTitleConflict(sent);
    renderDialog();

    await userEvent.upload(fileInput(), htmlFile());
    await userEvent.click(screen.getByRole("button", { name: "Upload" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Upload as a separate artifact" }),
    );

    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]?.get("allowDuplicateTitle")).toBe("true");
    expect(sent[1]?.get("artifactId")).toBeNull();
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

describe("choosing a folder", () => {
  const created = () => ({ status: 201, body: { artifact: artifact() } });

  test("files the artifact in the folder open in the gallery unless the person changes it", async () => {
    const sent: FormData[] = [];
    stubUploads(sent, created);
    renderDialog({ initialFolderId: "weekly" });

    const select = (await screen.findByLabelText("Folder")) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(select.value).toBe("weekly");
    // A nested folder shows its parents, so two folders with one name stay apart.
    expect(screen.getByRole("option", { name: "Reports › Weekly" })).toBeDefined();

    await userEvent.upload(fileInput(), htmlFile());
    await userEvent.click(screen.getByRole("button", { name: "Upload" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.get("folderId")).toBe("weekly");
  });

  test("sends no folder when the person picks No folder", async () => {
    const sent: FormData[] = [];
    stubUploads(sent, created);
    renderDialog({ initialFolderId: "reports" });

    const select = (await screen.findByLabelText("Folder")) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    await userEvent.selectOptions(select, "");
    await userEvent.upload(fileInput(), htmlFile());
    await userEvent.click(screen.getByRole("button", { name: "Upload" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.get("folderId")).toBeNull();
  });

  test("drops a folder the gallery names that no longer exists", async () => {
    const sent: FormData[] = [];
    stubUploads(sent, created, [REPORTS]);
    renderDialog({ initialFolderId: "deleted-folder" });

    const select = (await screen.findByLabelText("Folder")) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(select.value).toBe("");
  });

  // Adding a version to an artifact in another folder must not move it there.
  test("keeps the existing artifact's folder when the upload becomes a new version", async () => {
    const sent: FormData[] = [];
    stubUploads(sent, (count) =>
      count === 1
        ? {
            status: 409,
            body: { error: { code: "TITLE_EXISTS", message: "Taken.", artifactId: "existing" } },
          }
        : { status: 201, body: { artifact: artifact({ id: "existing" }) } },
    );
    renderDialog({ initialFolderId: "reports" });

    const select = (await screen.findByLabelText("Folder")) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    await userEvent.upload(fileInput(), htmlFile());
    await userEvent.click(screen.getByRole("button", { name: "Upload" }));
    await userEvent.click(await screen.findByRole("button", { name: "Add as a new version" }));

    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[0]?.get("folderId")).toBe("reports");
    expect(sent[1]?.get("artifactId")).toBe("existing");
    expect(sent[1]?.get("folderId")).toBeNull();
  });
});

describe("creating a folder", () => {
  const created = () => ({ status: 201, body: { artifact: artifact() } });

  async function chooseNewFolder(name: string) {
    const select = (await screen.findByLabelText("Folder")) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    await userEvent.selectOptions(select, "New folder...");
    if (name) await userEvent.type(screen.getByLabelText("New folder name"), name);
  }

  test("creates the named folder and files the upload in it", async () => {
    const sent: FormData[] = [];
    const createdFolders: string[] = [];
    stubUploads(sent, created, [REPORTS], createdFolders);
    renderDialog();

    await chooseNewFolder("  Launch  ");
    await userEvent.upload(fileInput(), htmlFile());
    await userEvent.click(screen.getByRole("button", { name: "Upload" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(createdFolders).toEqual(["Launch"]);
    expect(sent[0]?.get("folderId")).toBe("created-folder");
  });

  // The server refuses a second top-level folder with the same name.
  test("reuses a top-level folder with the same name instead of creating another", async () => {
    const sent: FormData[] = [];
    const createdFolders: string[] = [];
    stubUploads(sent, created, [REPORTS], createdFolders);
    renderDialog();

    await chooseNewFolder("reports");
    await userEvent.upload(fileInput(), htmlFile());
    await userEvent.click(screen.getByRole("button", { name: "Upload" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(createdFolders).toEqual([]);
    expect(sent[0]?.get("folderId")).toBe("reports");
  });

  test("asks for a name before sending anything", async () => {
    const sent: FormData[] = [];
    const createdFolders: string[] = [];
    stubUploads(sent, created, [REPORTS], createdFolders);
    renderDialog();

    await chooseNewFolder("");
    await userEvent.upload(fileInput(), htmlFile());
    await userEvent.click(screen.getByRole("button", { name: "Upload" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Name the new folder");
    expect(sent).toHaveLength(0);
    expect(createdFolders).toEqual([]);
  });

  test("creates the folder once when the upload is retried after a refusal", async () => {
    const sent: FormData[] = [];
    const createdFolders: string[] = [];
    stubUploads(
      sent,
      (count) =>
        count === 1
          ? {
              status: 409,
              body: { error: { code: "TITLE_EXISTS", message: "Taken.", artifactId: "existing" } },
            }
          : created(),
      [REPORTS],
      createdFolders,
    );
    renderDialog();

    await chooseNewFolder("Launch");
    await userEvent.upload(fileInput(), htmlFile());
    await userEvent.click(screen.getByRole("button", { name: "Upload" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Upload as a separate artifact" }),
    );

    await waitFor(() => expect(sent).toHaveLength(2));
    expect(createdFolders).toEqual(["Launch"]);
    expect(sent[1]?.get("folderId")).toBe("created-folder");
  });
});
