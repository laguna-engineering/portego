import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SharedArtifact } from "./SharedArtifact.tsx";
import { restoreFetch, stubFetch } from "./testing.ts";

const TOKEN = "link-secret";
const GUEST = { id: "guest:g1", name: "Dana", token: "guest-token" };

const SHARED = {
  artifact: {
    title: "Team lunch",
    description: null,
    creator: { name: "A Person" },
    updatedAt: new Date().toISOString(),
  },
  preview: { url: "http://content.test/preview/p/", expiresAt: new Date().toISOString() },
};

type Sent = { method: string; path: string; authorization: string | null; body: unknown };

/** Answers the public link's routes and records every write. */
function stubShared(): Sent[] {
  const sent: Sent[] = [];
  stubFetch((path, init) => {
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      sent.push({
        method,
        path,
        authorization: new Headers(init?.headers).get("authorization"),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
    }
    if (path.endsWith("/guest")) {
      return { body: { guest: { id: GUEST.id, name: GUEST.name }, token: GUEST.token } };
    }
    if (path.includes("/entries")) {
      return method === "GET" ? { body: { entries: [], schema: null } } : { body: { entry: {} } };
    }
    return { body: SHARED };
  });
  return sent;
}

async function sendFromFrame(frame: HTMLIFrameElement, message: Record<string, unknown>) {
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { portego: 1, ...message },
        source: frame.contentWindow as unknown as MessageEventSource,
      }),
    );
  });
}

beforeEach(() => {
  window.localStorage.clear();
  Object.defineProperty(navigator, "userActivation", {
    value: { isActive: true },
    configurable: true,
  });
});

afterEach(() => {
  restoreFetch();
  delete (navigator as { userActivation?: unknown }).userActivation;
});

describe("an artifact opened with its public link", () => {
  test("shows the artifact and who shared it", async () => {
    stubShared();
    render(<SharedArtifact token={TOKEN} />);
    const frame = (await screen.findByTitle("Preview of Team lunch")) as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.src).toBe(SHARED.preview.url);
    expect(screen.getByText("Shared by A Person")).toBeDefined();
  });

  test("sends a signed-in member to the artifact itself", async () => {
    stubFetch(() => ({ body: { ...SHARED, artifactId: "artifact-1" } }));
    const replace = spyOn(window.location, "replace").mockImplementation(() => {});
    render(<SharedArtifact token={TOKEN} />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/a/artifact-1"));
    expect(screen.queryByTitle("Preview of Team lunch")).toBeNull();
    replace.mockRestore();
  });

  test("says a revoked or unknown link does not work", async () => {
    stubFetch(() => ({ status: 404, body: { error: { code: "NOT_FOUND", message: "x" } } }));
    render(<SharedArtifact token={TOKEN} />);
    expect(await screen.findByText("This link does not work")).toBeDefined();
  });

  test("asks for a name before the first entry, then saves it under that name", async () => {
    const sent = stubShared();
    render(<SharedArtifact token={TOKEN} />);
    const frame = (await screen.findByTitle("Preview of Team lunch")) as HTMLIFrameElement;

    await sendFromFrame(frame, { type: "set", key: "rsvp", value: "yes" });
    expect(sent).toEqual([]);
    await userEvent.type(await screen.findByLabelText("Your name"), "Dana");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));

    await screen.findByText("Adding as Dana.");
    expect(sent).toEqual([
      {
        method: "POST",
        path: `/api/shared/${TOKEN}/guest`,
        authorization: null,
        body: { name: "Dana" },
      },
      {
        method: "PUT",
        path: `/api/shared/${TOKEN}/entries`,
        authorization: `Guest ${GUEST.token}`,
        body: { key: "rsvp", value: "yes" },
      },
    ]);
  });

  test("remembers the name on this link, so a returning reader is not asked again", async () => {
    window.localStorage.setItem(`portego-guest:${TOKEN}`, JSON.stringify(GUEST));
    const sent = stubShared();
    render(<SharedArtifact token={TOKEN} />);
    const frame = (await screen.findByTitle("Preview of Team lunch")) as HTMLIFrameElement;

    await sendFromFrame(frame, { type: "clear", key: "rsvp" });
    expect(screen.queryByLabelText("Your name")).toBeNull();
    expect(sent).toEqual([
      {
        method: "DELETE",
        path: `/api/shared/${TOKEN}/entries?key=rsvp`,
        authorization: `Guest ${GUEST.token}`,
        body: null,
      },
    ]);
  });

  test("ignores a write the reader did not click for", async () => {
    Object.defineProperty(navigator, "userActivation", {
      value: { isActive: false },
      configurable: true,
    });
    const sent = stubShared();
    render(<SharedArtifact token={TOKEN} />);
    const frame = (await screen.findByTitle("Preview of Team lunch")) as HTMLIFrameElement;

    await sendFromFrame(frame, { type: "set", key: "rsvp", value: "yes" });
    expect(screen.queryByLabelText("Your name")).toBeNull();
    expect(sent).toEqual([]);
  });
});
