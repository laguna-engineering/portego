import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Comments } from "./Comments.tsx";
import { restoreFetch, StubEventSource, stubFetch } from "./testing.ts";

afterEach(restoreFetch);
beforeEach(() => StubEventSource.install());

/** Announces a change and waits for whatever the thread does about it. */
async function announce(event: Parameters<StubEventSource["send"]>[0]) {
  const stream = StubEventSource.last;
  if (!stream) throw new Error("No stream was opened");
  await act(async () => {
    stream.send(event);
  });
}

/** Picks an element out of a query result, failing loudly if it is missing. */
function at<T>(items: T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`Expected an element at index ${index}`);
  return item;
}

function comment(overrides: Record<string, unknown> = {}) {
  return {
    id: "comment-1",
    body: "A thought",
    createdAt: new Date().toISOString(),
    author: { id: "user-1", name: "A Person", email: "person@acme.example" },
    anchor: null,
    parentId: null,
    versionId: "artifact-1",
    versionNumber: 1,
    ...overrides,
  };
}

describe("reading", () => {
  test("shows each comment with its author and time", async () => {
    stubFetch(() => ({ body: { comments: [comment()] } }));
    render(<Comments artifactId="artifact-1" currentUserId="user-1" />);

    expect(await screen.findByText("A thought")).toBeDefined();
    expect(screen.getByText(/A Person/)).toBeDefined();
  });

  test("says when there is nothing yet", async () => {
    stubFetch(() => ({ body: { comments: [] } }));
    render(<Comments artifactId="artifact-1" currentUserId="user-1" />);

    expect(await screen.findByText("No comments yet.")).toBeDefined();
  });
});

describe("writing", () => {
  test("adds a comment and shows it without a reload", async () => {
    const posted: string[] = [];
    stubFetch((_path, init) => {
      if (init?.method === "POST") {
        posted.push(String(JSON.parse(String(init.body)).body));
        return { status: 201, body: { comment: comment({ id: "comment-2", body: "New one" }) } };
      }
      return { body: { comments: [] } };
    });

    render(<Comments artifactId="artifact-1" currentUserId="user-1" />);
    await userEvent.type(await screen.findByLabelText("Add a comment"), "New one");
    await userEvent.click(screen.getByRole("button", { name: "Comment" }));

    expect(await screen.findByText("New one")).toBeDefined();
    expect(posted).toEqual(["New one"]);
  });

  test("writes a root comment with the version being viewed", async () => {
    const posted: unknown[] = [];
    stubFetch((_path, init) => {
      if (init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)));
        return { status: 201, body: { comment: comment({ id: "comment-2", body: "Yes" }) } };
      }
      return { body: { comments: [] } };
    });

    render(<Comments artifactId="artifact-1" currentUserId="user-1" versionId="ver-1" />);
    await userEvent.type(await screen.findByLabelText("Add a comment"), "Yes");
    await userEvent.click(screen.getByRole("button", { name: "Comment" }));

    expect(posted).toEqual([{ body: "Yes", versionId: "ver-1" }]);
  });

  test("refuses an empty comment before asking the server", async () => {
    let posts = 0;
    stubFetch((_path, init) => {
      if (init?.method === "POST") posts += 1;
      return { body: { comments: [] } };
    });

    render(<Comments artifactId="artifact-1" currentUserId="user-1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Comment" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Write something first.");
    expect(posts).toBe(0);
  });

  test("reports what the server refused", async () => {
    stubFetch((_path, init) =>
      init?.method === "POST"
        ? { status: 400, body: { error: { code: "INVALID_INPUT", message: "Too long." } } }
        : { body: { comments: [] } },
    );

    render(<Comments artifactId="artifact-1" currentUserId="user-1" />);
    await userEvent.type(await screen.findByLabelText("Add a comment"), "x");
    await userEvent.click(screen.getByRole("button", { name: "Comment" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Too long.");
  });
});

describe("removing", () => {
  test("offers removal only on your own comment", async () => {
    stubFetch(() => ({
      body: {
        comments: [
          comment({ id: "mine", body: "Mine" }),
          comment({
            id: "theirs",
            body: "Theirs",
            author: { id: "user-2", name: "Someone", email: "s@x.test" },
          }),
        ],
      },
    }));

    render(<Comments artifactId="artifact-1" currentUserId="user-1" />);
    await screen.findByText("Theirs");
    expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(1);
  });

  test("removes a comment from the thread", async () => {
    stubFetch((_path, init) =>
      init?.method === "DELETE" ? { status: 204, body: {} } : { body: { comments: [comment()] } },
    );

    render(<Comments artifactId="artifact-1" currentUserId="user-1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Remove" }));

    await waitFor(() => expect(screen.queryByText("A thought")).toBeNull());
  });

  test("offers no way to edit an existing comment", async () => {
    stubFetch(() => ({ body: { comments: [comment()] } }));
    render(<Comments artifactId="artifact-1" currentUserId="user-1" />);

    await screen.findByText("A thought");
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });
});

describe("threading", () => {
  test("replies render under their root and not as separate top-level entries", async () => {
    stubFetch(() => ({
      body: {
        comments: [
          comment({ id: "root-1", body: "Root thought" }),
          comment({
            id: "reply-1",
            body: "A reply",
            parentId: "root-1",
            author: { id: "user-2", name: "Someone", email: "s@x.test" },
          }),
        ],
      },
    }));
    render(<Comments artifactId="artifact-1" currentUserId="user-1" />);

    await screen.findByText("Root thought");
    const reply = await screen.findByText("A reply");
    expect(document.getElementById("comment-root-1")?.contains(reply)).toBe(true);
    // A reply gets no id of its own: it is not a top-level entry.
    expect(document.getElementById("comment-reply-1")).toBeNull();
  });

  test("clicking Reply opens one composer and opening another closes the first", async () => {
    stubFetch(() => ({
      body: {
        comments: [
          comment({
            id: "root-1",
            body: "First root",
            author: { id: "user-2", name: "Ana", email: "a@x.test" },
          }),
          comment({
            id: "root-2",
            body: "Second root",
            author: { id: "user-3", name: "Bo", email: "b@x.test" },
          }),
        ],
      },
    }));
    render(<Comments artifactId="artifact-1" currentUserId="user-1" />);
    await screen.findByText("First root");

    const opened = screen.getAllByRole("button", { name: "Reply" });
    await userEvent.click(at(opened, 0));
    expect(await screen.findByLabelText("Reply to Ana")).toBeDefined();

    const remaining = screen.getAllByRole("button", { name: "Reply" });
    await userEvent.click(at(remaining, remaining.length - 1));

    expect(screen.queryByLabelText("Reply to Ana")).toBeNull();
    expect(await screen.findByLabelText("Reply to Bo")).toBeDefined();
  });

  test("posting a reply sends parentId and no anchor, and the reply appears in the thread", async () => {
    const posted: unknown[] = [];
    stubFetch((_path, init) => {
      if (init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)));
        return {
          status: 201,
          body: { comment: comment({ id: "reply-1", body: "Thanks", parentId: "root-1" }) },
        };
      }
      return { body: { comments: [comment({ id: "root-1", body: "Root thought" })] } };
    });
    render(<Comments artifactId="artifact-1" currentUserId="user-1" />);
    await screen.findByText("Root thought");

    await userEvent.click(screen.getByRole("button", { name: "Reply" }));
    await userEvent.type(screen.getByLabelText(/Reply to /), "Thanks");
    await userEvent.click(screen.getByRole("button", { name: "Reply" }));

    const reply = await screen.findByText("Thanks");
    expect(document.getElementById("comment-root-1")?.contains(reply)).toBe(true);
    expect(posted).toEqual([{ body: "Thanks", parentId: "root-1" }]);
  });

  test("removing a root drops its replies from the list", async () => {
    stubFetch((_path, init) => {
      if (init?.method === "DELETE") return { status: 204, body: {} };
      return {
        body: {
          comments: [
            comment({ id: "root-1", body: "Root thought" }),
            comment({ id: "reply-1", body: "A reply", parentId: "root-1" }),
          ],
        },
      };
    });
    render(<Comments artifactId="artifact-1" currentUserId="user-1" />);
    await screen.findByText("Root thought");
    await screen.findByText("A reply");

    const removeButtons = screen.getAllByRole("button", { name: "Remove" });
    await userEvent.click(at(removeButtons, 0));

    await waitFor(() => expect(screen.queryByText("Root thought")).toBeNull());
    expect(screen.queryByText("A reply")).toBeNull();
  });

  test("a reply from someone else arriving through a live event lands under the right root", async () => {
    let listed = [comment({ id: "root-1", body: "Root thought" })];
    stubFetch(() => ({ body: { comments: listed } }));
    render(<Comments artifactId="artifact-1" currentUserId="user-1" />);
    await screen.findByText("Root thought");

    listed = [
      ...listed,
      comment({
        id: "reply-1",
        body: "Someone's reply",
        parentId: "root-1",
        author: { id: "user-2", name: "Someone", email: "s@x.test" },
      }),
    ];
    await announce({ type: "comment.changed", artifactId: "artifact-1" });

    const reply = await screen.findByText("Someone's reply");
    expect(document.getElementById("comment-root-1")?.contains(reply)).toBe(true);
  });

  test("an empty reply is refused client-side with the existing message", async () => {
    let posts = 0;
    stubFetch((_path, init) => {
      if (init?.method === "POST") posts += 1;
      return { body: { comments: [comment({ id: "root-1", body: "Root thought" })] } };
    });
    render(<Comments artifactId="artifact-1" currentUserId="user-1" />);
    await screen.findByText("Root thought");

    await userEvent.click(screen.getByRole("button", { name: "Reply" }));
    await userEvent.click(screen.getByRole("button", { name: "Reply" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Write something first.");
    expect(posts).toBe(0);
  });
});

describe("live updates", () => {
  test("shows a comment somebody else wrote, with no reload", async () => {
    let listed = [comment()];
    stubFetch(() => ({ body: { comments: listed } }));
    render(<Comments artifactId="artifact-1" currentUserId="user-1" />);
    expect(await screen.findByText("A thought")).toBeDefined();

    listed = [...listed, comment({ id: "comment-2", body: "A reply" })];
    await announce({ type: "comment.changed", artifactId: "artifact-1" });

    expect(await screen.findByText("A reply")).toBeDefined();
  });

  test("ignores a comment on another artifact", async () => {
    let calls = 0;
    stubFetch(() => {
      calls += 1;
      return { body: { comments: [comment()] } };
    });
    render(<Comments artifactId="artifact-1" currentUserId="user-1" />);
    await screen.findByText("A thought");
    const before = calls;

    await announce({ type: "comment.changed", artifactId: "artifact-2" });

    expect(calls).toBe(before);
  });

  test("shows a comment once when its own announcement arrives first", async () => {
    const listed = [comment()];
    stubFetch((_path, init) => {
      if (init?.method === "POST") {
        const created = comment({ id: "comment-2", body: "A reply" });
        listed.push(created);
        return { body: { comment: created } };
      }
      return { body: { comments: [...listed] } };
    });
    render(<Comments artifactId="artifact-1" currentUserId="user-1" />);
    await screen.findByText("A thought");

    await userEvent.type(screen.getByLabelText("Add a comment"), "A reply");
    await userEvent.click(screen.getByRole("button", { name: "Comment" }));
    // The server announces the comment as it is written, so the refetch and the
    // POST response both carry it.
    await announce({ type: "comment.changed", artifactId: "artifact-1" });

    expect(screen.getAllByText("A reply")).toHaveLength(1);
  });
});

describe("anchors", () => {
  test("shows a comment's quote and asks to reveal it in the artifact when clicked", async () => {
    stubFetch(() => ({
      body: {
        comments: [
          comment({
            id: "comment-1",
            body: "Check this out",
            anchor: { quote: "the important part", prefix: "", suffix: "" },
          }),
        ],
      },
    }));
    const revealed: string[] = [];
    render(
      <Comments
        artifactId="artifact-1"
        currentUserId="user-1"
        onFocusComment={(id) => revealed.push(id)}
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: "the important part" }));

    expect(revealed).toEqual(["comment-1"]);
  });

  test("truncates a long quote so the thread stays scannable", async () => {
    const longQuote = "x".repeat(200);
    stubFetch(() => ({
      body: { comments: [comment({ anchor: { quote: longQuote, prefix: "", suffix: "" } })] },
    }));
    render(<Comments artifactId="artifact-1" currentUserId="user-1" />);

    const quote = await screen.findByRole("button", { name: /x+…$/ });
    expect(quote.textContent?.length).toBeLessThan(longQuote.length);
  });

  test("offers a pending selection in the composer and posts it as the anchor", async () => {
    const posted: unknown[] = [];
    stubFetch((_path, init) => {
      if (init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)));
        return { status: 201, body: { comment: comment({ id: "comment-2", body: "Yes" }) } };
      }
      return { body: { comments: [] } };
    });
    let cleared = false;
    render(
      <Comments
        artifactId="artifact-1"
        currentUserId="user-1"
        anchor={{ quote: "a passage", prefix: "", suffix: "" }}
        onClearAnchor={() => (cleared = true)}
      />,
    );

    expect(await screen.findByText("a passage")).toBeDefined();
    await userEvent.type(screen.getByLabelText("Add a comment"), "Yes");
    await userEvent.click(screen.getByRole("button", { name: "Comment" }));

    // The anchor rides with the comment it is attached to, not a second call.
    expect(posted).toEqual([
      { body: "Yes", anchor: { quote: "a passage", prefix: "", suffix: "" } },
    ]);
    // A posted anchor cannot also be offered on the next comment.
    expect(cleared).toBe(true);
  });

  test("lets a pending selection be removed before it is posted", async () => {
    stubFetch(() => ({ body: { comments: [] } }));
    let cleared = false;
    render(
      <Comments
        artifactId="artifact-1"
        currentUserId="user-1"
        anchor={{ quote: "a passage", prefix: "", suffix: "" }}
        onClearAnchor={() => (cleared = true)}
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: "Remove selection" }));

    expect(cleared).toBe(true);
  });
});

describe("focus", () => {
  test("highlights the comment the artifact reports focusing", async () => {
    stubFetch(() => ({
      body: {
        comments: [
          comment({ id: "comment-1", body: "First" }),
          comment({ id: "comment-2", body: "Second" }),
        ],
      },
    }));
    render(<Comments artifactId="artifact-1" currentUserId="user-1" focusedId="comment-2" />);

    await screen.findByText("Second");
    expect(document.getElementById("comment-comment-2")?.className).toContain("focused");
    expect(document.getElementById("comment-comment-1")?.className).not.toContain("focused");
  });
});

describe("embedding", () => {
  test("skips its own heading when a container already renders one", async () => {
    stubFetch(() => ({ body: { comments: [] } }));
    render(<Comments artifactId="artifact-1" currentUserId="user-1" heading={false} />);

    await screen.findByText("No comments yet.");
    expect(screen.queryByRole("heading", { name: "Comments" })).toBeNull();
  });

  test("reports the comment list to a container that needs it to drive highlights", async () => {
    const listed = [comment()];
    stubFetch(() => ({ body: { comments: listed } }));
    const reported: unknown[] = [];
    render(
      <Comments
        artifactId="artifact-1"
        currentUserId="user-1"
        onComments={(list) => reported.push(list)}
      />,
    );

    await screen.findByText("A thought");
    expect(reported.at(-1)).toEqual(listed);
  });
});

describe("versions", () => {
  test("badges a comment from another version and leaves the viewed version's comment unbadged", async () => {
    stubFetch(() => ({
      body: {
        comments: [
          comment({ id: "c1", body: "On v2", versionId: "ver-2", versionNumber: 2 }),
          comment({ id: "c2", body: "On v1", versionId: "ver-1", versionNumber: 1 }),
        ],
      },
    }));
    render(<Comments artifactId="artifact-1" currentUserId="user-1" viewedVersionNumber={2} />);

    await screen.findByText("On v2");
    expect(document.querySelector("#comment-c1 .version-badge")).toBeNull();
    expect(document.querySelector("#comment-c2 .version-badge")?.textContent).toBe("v1");
  });

  test("badges a reply written on a version other than the one being viewed", async () => {
    stubFetch(() => ({
      body: {
        comments: [
          comment({ id: "root-1", body: "Root thought", versionId: "ver-2", versionNumber: 2 }),
          comment({
            id: "reply-1",
            body: "A reply",
            parentId: "root-1",
            versionId: "ver-1",
            versionNumber: 1,
          }),
        ],
      },
    }));
    render(<Comments artifactId="artifact-1" currentUserId="user-1" viewedVersionNumber={2} />);

    await screen.findByText("A reply");
    // The root's own meta carries no badge; only its reply's does.
    expect(document.querySelector("#comment-root-1 > p.comment-meta .version-badge")).toBeNull();
    const replyBadge = document.querySelector("#comment-root-1 .comment-replies .version-badge");
    expect(replyBadge?.textContent).toBe("v1");
  });

  test("shows no badge when nothing is being viewed in particular", async () => {
    stubFetch(() => ({
      body: { comments: [comment({ id: "c1", versionId: "ver-9", versionNumber: 9 })] },
    }));
    render(<Comments artifactId="artifact-1" currentUserId="user-1" />);

    await screen.findByText("A thought");
    expect(document.querySelector(".version-badge")).toBeNull();
  });
});
