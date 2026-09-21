import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ArtifactDetail } from "./ArtifactDetail.tsx";
import { artifact, restoreFetch, StubEventSource, stubFetch, stubFetchWith } from "./testing.ts";

afterEach(restoreFetch);
beforeEach(() => StubEventSource.install());

/** Announces a change and waits for whatever the page does about it. */
async function announce(event: Parameters<StubEventSource["send"]>[0]) {
  const stream = StubEventSource.last;
  if (!stream) throw new Error("No stream was opened");
  await act(async () => {
    stream.send(event);
  });
}

function json(body: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

function answer(path: string) {
  if (path.endsWith("/preview")) return { body: { url: "http://127.0.0.1:5173/preview/token" } };
  if (path.endsWith("/comments")) return { body: { comments: [] } };
  if (path.endsWith("/markdown")) {
    return {
      body: {
        markdown: "# Sales chart\n\nQ3 by region",
        empty: false,
        converterVersion: "1",
        generatedAt: new Date().toISOString(),
      },
    };
  }
  return { body: { artifact: artifact() } };
}

describe("ready", () => {
  test("shows the metadata a reader needs to trust the artifact", async () => {
    stubFetch(answer);
    render(
      <ArtifactDetail
        id="artifact-1"
        currentUserId="user-1"
        onBack={() => {}}
        onFullScreen={() => {}}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Sales chart" })).toBeDefined();
    expect(screen.getByText("Q3 by region")).toBeDefined();
    expect(screen.getByText(/A Person/)).toBeDefined();
    expect(screen.getByText(/2 KiB/)).toBeDefined();
    expect(screen.getByText("a".repeat(64))).toBeDefined();
  });

  test("offers the full-screen view as a link the reader can open either way", async () => {
    stubFetch(answer);
    let opened = false;
    render(
      <ArtifactDetail
        id="artifact-1"
        currentUserId="user-1"
        onBack={() => {}}
        onFullScreen={() => {
          opened = true;
        }}
      />,
    );

    const link = (await screen.findByRole("link", { name: "Full screen" })) as HTMLAnchorElement;
    // A stable application path, not a preview token. The token is minted by
    // the page it opens, so the link cannot go stale sitting here. Naming the
    // path is also what lets the reader open it in a tab of their choosing.
    expect(link.getAttribute("href")).toBe("/a/artifact-1/full");
    expect(link.getAttribute("target")).toBeNull();
    // A plain click stays in this tab, and the application routes it.
    fireEvent.click(link);
    expect(opened).toBe(true);
  });

  test("leaves a modified click to the browser, which opens it in a new tab", async () => {
    stubFetch(answer);
    let opened = false;
    render(
      <ArtifactDetail
        id="artifact-1"
        currentUserId="user-1"
        onBack={() => {}}
        onFullScreen={() => {
          opened = true;
        }}
      />,
    );

    const link = await screen.findByRole("link", { name: "Full screen" });
    fireEvent.click(link, { metaKey: true });
    expect(opened).toBe(false);
    // The new context gets no handle on this one.
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  test("offers the source as a download that keeps the original name", async () => {
    stubFetch(answer);
    render(
      <ArtifactDetail
        id="artifact-1"
        currentUserId="user-1"
        onBack={() => {}}
        onFullScreen={() => {}}
      />,
    );

    const link = (await screen.findByRole("link", {
      name: "Download source",
    })) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/api/artifacts/artifact-1/source");
    expect(link.getAttribute("download")).toBe("chart.html");
  });

  test("renders the artifact in a sandboxed frame served by the content host", async () => {
    stubFetch(answer);
    const { container } = render(
      <ArtifactDetail
        id="artifact-1"
        currentUserId="user-1"
        onBack={() => {}}
        onFullScreen={() => {}}
      />,
    );

    await screen.findByRole("heading", { name: "Sales chart" });
    const frame = await screen.findByTitle("Preview of Sales chart");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("src")).toBe("http://127.0.0.1:5173/preview/token");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(container.innerHTML).not.toContain("<script");
  });

  test("copies a link that reproduces this page", async () => {
    stubFetch(answer);
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => void copied.push(text) },
    });

    render(
      <ArtifactDetail
        id="artifact-1"
        currentUserId="user-1"
        onBack={() => {}}
        onFullScreen={() => {}}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Copy link" }));

    expect(copied).toEqual(["http://localhost:5173/a/artifact-1"]);
    expect(await screen.findByRole("button", { name: "Link copied" })).toBeDefined();
  });
});

describe("text view", () => {
  test("shows the static content as text on request", async () => {
    stubFetch(answer);
    render(
      <ArtifactDetail
        id="artifact-1"
        currentUserId="user-1"
        onBack={() => {}}
        onFullScreen={() => {}}
      />,
    );

    await userEvent.click(await screen.findByRole("tab", { name: "Text" }));
    expect(await screen.findByText(/# Sales chart/)).toBeDefined();
    expect(screen.queryByTitle("Preview of Sales chart")).toBeNull();
  });

  test("explains an artifact that draws itself with JavaScript", async () => {
    stubFetch((path) =>
      path.endsWith("/markdown")
        ? {
            body: {
              markdown: "",
              empty: true,
              converterVersion: "1",
              generatedAt: new Date().toISOString(),
            },
          }
        : answer(path),
    );
    render(
      <ArtifactDetail
        id="artifact-1"
        currentUserId="user-1"
        onBack={() => {}}
        onFullScreen={() => {}}
      />,
    );

    await userEvent.click(await screen.findByRole("tab", { name: "Text" }));
    expect(await screen.findByText(/no static text/)).toBeDefined();
  });

  test("goes back to the preview", async () => {
    stubFetch(answer);
    render(
      <ArtifactDetail
        id="artifact-1"
        currentUserId="user-1"
        onBack={() => {}}
        onFullScreen={() => {}}
      />,
    );

    await userEvent.click(await screen.findByRole("tab", { name: "Text" }));
    await userEvent.click(screen.getByRole("tab", { name: "Preview" }));
    expect(await screen.findByTitle("Preview of Sales chart")).toBeDefined();
  });
});

describe("failures", () => {
  test("says an artifact does not exist, and does not offer a pointless retry", async () => {
    stubFetch(() => ({
      status: 404,
      body: { error: { code: "NOT_FOUND", message: "No such artifact." } },
    }));
    render(
      <ArtifactDetail
        id="missing"
        currentUserId="user-1"
        onBack={() => {}}
        onFullScreen={() => {}}
      />,
    );

    expect((await screen.findByRole("alert")).textContent).toBe("That artifact does not exist.");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  test("offers a retry when the failure might not repeat", async () => {
    stubFetch(() => ({
      status: 500,
      body: { error: { code: "INTERNAL", message: "Something went wrong." } },
    }));
    render(
      <ArtifactDetail
        id="artifact-1"
        currentUserId="user-1"
        onBack={() => {}}
        onFullScreen={() => {}}
      />,
    );

    expect(await screen.findByRole("alert")).toBeDefined();
    expect(screen.getByRole("button", { name: "Try again" })).toBeDefined();
  });

  test("leads back to the gallery from a failure", async () => {
    stubFetch(() => ({
      status: 404,
      body: { error: { code: "NOT_FOUND", message: "No such artifact." } },
    }));
    let back = false;
    render(
      <ArtifactDetail
        id="missing"
        currentUserId="user-1"
        onBack={() => (back = true)}
        onFullScreen={() => {}}
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: "Back to the gallery" }));
    expect(back).toBe(true);
  });
});

describe("superseded responses", () => {
  test("keeps the artifact asked for last when an earlier request answers late", async () => {
    let answerFirst: (() => void) | undefined;
    stubFetchWith((path) => {
      if (path.endsWith("/preview")) {
        return json({ url: "http://127.0.0.1:5173/preview/token" });
      }
      if (path.includes("artifact-1")) {
        // Held open so that artifact 2 answers first.
        return new Promise<Response>((resolve) => {
          answerFirst = () => resolve(json({ artifact: artifact({ title: "First" }) }));
        });
      }
      return json({ artifact: artifact({ title: "Second" }) });
    });

    const { rerender } = render(
      <ArtifactDetail
        id="artifact-1"
        currentUserId="user-1"
        onBack={() => {}}
        onFullScreen={() => {}}
      />,
    );
    rerender(
      <ArtifactDetail
        id="artifact-2"
        currentUserId="user-1"
        onBack={() => {}}
        onFullScreen={() => {}}
      />,
    );
    expect(await screen.findByRole("heading", { name: "Second" })).toBeDefined();

    answerFirst?.();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Second" })).toBeDefined());
    expect(screen.queryByRole("heading", { name: "First" })).toBeNull();
  });
});

describe("status and archiving", () => {
  test("marks an artifact solved and shows the state it is now in", async () => {
    const sent: { path: string; method?: string; body?: unknown }[] = [];
    stubFetch((path, init) => {
      if (!path.endsWith("/status")) return answer(path);
      sent.push({ path, method: init?.method, body: JSON.parse(String(init?.body)) });
      return { body: { artifact: artifact({ status: "solved" }) } };
    });

    render(
      <ArtifactDetail
        id="artifact-1"
        currentUserId="user-1"
        onBack={() => {}}
        onFullScreen={() => {}}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Mark solved" }));

    expect(await screen.findByText("solved")).toBeDefined();
    // The one button reads as the action left to take, so nobody has to
    // remember which state they are in.
    expect(screen.getByRole("button", { name: "Reopen" })).toBeDefined();
    expect(sent).toEqual([
      { path: "/api/artifacts/artifact-1/status", method: "PATCH", body: { status: "solved" } },
    ]);
  });

  test("archives an artifact and offers to restore it", async () => {
    stubFetch((path) =>
      path.endsWith("/archived")
        ? { body: { artifact: artifact({ archivedAt: new Date().toISOString() }) } }
        : answer(path),
    );

    render(
      <ArtifactDetail
        id="artifact-1"
        currentUserId="user-1"
        onBack={() => {}}
        onFullScreen={() => {}}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Archive" }));

    expect(await screen.findByText("archived")).toBeDefined();
    expect(screen.getByRole("button", { name: "Restore" })).toBeDefined();
  });

  test("says what the server refused and leaves the artifact as it was", async () => {
    stubFetch((path) =>
      path.endsWith("/status")
        ? { status: 403, body: { error: { code: "FORBIDDEN", message: "Not yours to change." } } }
        : answer(path),
    );

    render(
      <ArtifactDetail
        id="artifact-1"
        currentUserId="user-1"
        onBack={() => {}}
        onFullScreen={() => {}}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Mark solved" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Not yours to change.");
    // Still open, so the page never showed a change that did not happen.
    expect(screen.getByRole("button", { name: "Mark solved" })).toBeDefined();
  });
});

describe("live updates", () => {
  test("shows a status somebody else set, with no reload", async () => {
    let current = artifact();
    stubFetch((path) =>
      path.endsWith("/preview") || path.endsWith("/comments") || path.endsWith("/markdown")
        ? answer(path)
        : { body: { artifact: current } },
    );
    render(
      <ArtifactDetail
        id="artifact-1"
        currentUserId="user-1"
        onBack={() => {}}
        onFullScreen={() => {}}
      />,
    );
    expect(await screen.findByRole("button", { name: "Mark solved" })).toBeDefined();

    current = artifact({ status: "solved" });
    await announce({ type: "artifact.changed", id: "artifact-1" });

    expect(await screen.findByRole("button", { name: "Reopen" })).toBeDefined();
    expect(screen.getByText("solved")).toBeDefined();
  });

  test("keeps the artifact on screen while it refreshes", async () => {
    stubFetch(answer);
    render(
      <ArtifactDetail
        id="artifact-1"
        currentUserId="user-1"
        onBack={() => {}}
        onFullScreen={() => {}}
      />,
    );
    await screen.findByRole("heading", { name: /Sales chart/ });

    await announce({ type: "artifact.changed", id: "artifact-1" });

    // The reader is looking at this page. A refresh they did not ask for must
    // not replace it with a loading message.
    expect(screen.queryByText("Loading artifact...")).toBeNull();
    expect(screen.getByRole("heading", { name: /Sales chart/ })).toBeDefined();
  });

  test("ignores a change to some other artifact", async () => {
    let calls = 0;
    stubFetch((path) => {
      if (
        !path.endsWith("/preview") &&
        !path.endsWith("/comments") &&
        !path.endsWith("/markdown")
      ) {
        calls += 1;
      }
      return answer(path);
    });
    render(
      <ArtifactDetail
        id="artifact-1"
        currentUserId="user-1"
        onBack={() => {}}
        onFullScreen={() => {}}
      />,
    );
    await screen.findByRole("heading", { name: /Sales chart/ });
    const before = calls;

    await announce({ type: "artifact.changed", id: "artifact-2" });

    expect(calls).toBe(before);
  });
});
