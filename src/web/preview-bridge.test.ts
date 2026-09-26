import { describe, expect, test } from "bun:test";
import { readBridgeMessage, readerIsActing } from "./preview-bridge.ts";

function selectionMessage(overrides: Record<string, unknown> = {}) {
  return {
    portego: 1,
    type: "selection",
    anchor: { quote: "a line", prefix: "before", suffix: "after" },
    ...overrides,
  };
}

describe("readBridgeMessage", () => {
  test("accepts a well-formed rect alongside the anchor", () => {
    const rect = { top: 1, left: 2, right: 3, bottom: 4 };

    expect(readBridgeMessage(selectionMessage({ rect }))).toEqual({
      type: "selection",
      anchor: { quote: "a line", prefix: "before", suffix: "after" },
      rect,
    });
  });

  test("drops a rect with a non-numeric side, rather than trusting a partial box", () => {
    const message = selectionMessage({ rect: { top: 1, left: 2, right: "3", bottom: 4 } });

    expect(readBridgeMessage(message)).toEqual({
      type: "selection",
      anchor: { quote: "a line", prefix: "before", suffix: "after" },
      rect: null,
    });
  });

  test("drops a rect with a NaN side", () => {
    const message = selectionMessage({ rect: { top: 1, left: 2, right: 3, bottom: Number.NaN } });

    expect(readBridgeMessage(message)).toEqual({
      type: "selection",
      anchor: { quote: "a line", prefix: "before", suffix: "after" },
      rect: null,
    });
  });

  test("cuts a quote and its context to the limits the preview is allowed to send", () => {
    const message = selectionMessage({
      anchor: { quote: "q".repeat(600), prefix: "p".repeat(200), suffix: "s".repeat(200) },
    });

    const read = readBridgeMessage(message);
    expect(read?.type).toBe("selection");
    expect(read?.type === "selection" && read.anchor?.quote).toHaveLength(500);
    expect(read?.type === "selection" && read.anchor?.prefix).toHaveLength(100);
    expect(read?.type === "selection" && read.anchor?.suffix).toHaveLength(100);
  });

  test("treats a message without the portego marker as coming from an untrusted frame", () => {
    const { portego: _portego, ...rest } = selectionMessage();
    expect(readBridgeMessage(rest)).toBeNull();
  });

  test("accepts a link to another site", () => {
    expect(
      readBridgeMessage({ portego: 1, type: "open", url: "https://example.com/a?b=c#d" }),
    ).toEqual({
      type: "open",
      url: "https://example.com/a?b=c#d",
    });
  });

  test("refuses a link that would run script or render data in the new tab", () => {
    // Opened from the application's page, these would run with its origin or
    // show content the reader could take for the application's own.
    for (const url of ["javascript:alert(1)", "data:text/html,<p>hi</p>", "blob:https://x/1"]) {
      expect(readBridgeMessage({ portego: 1, type: "open", url })).toBeNull();
    }
  });

  test("refuses a relative link, which would resolve against the application", () => {
    expect(readBridgeMessage({ portego: 1, type: "open", url: "/api/artifacts" })).toBeNull();
  });

  test("refuses an over-long link rather than cutting it to somewhere else", () => {
    const url = `https://example.com/${"a".repeat(2048)}`;
    expect(readBridgeMessage({ portego: 1, type: "open", url })).toBeNull();
  });

  test("ignores a message of a type the bridge does not know", () => {
    expect(readBridgeMessage({ portego: 1, type: "eval" })).toBeNull();
  });

  test("accepts an entry write with a JSON value", () => {
    expect(
      readBridgeMessage({ portego: 1, type: "set", key: "vote:P-01", value: { up: true } }),
    ).toEqual({ type: "set", key: "vote:P-01", value: { up: true } });
    expect(readBridgeMessage({ portego: 1, type: "clear", key: "vote:P-01" })).toEqual({
      type: "clear",
      key: "vote:P-01",
    });
  });

  test("refuses an entry write the server would refuse, instead of cutting it to fit", () => {
    expect(readBridgeMessage({ portego: 1, type: "set", key: "", value: 1 })).toBeNull();
    expect(
      readBridgeMessage({ portego: 1, type: "set", key: "x".repeat(201), value: 1 }),
    ).toBeNull();
    expect(
      readBridgeMessage({ portego: 1, type: "set", key: "note", value: "x".repeat(4000) }),
    ).toBeNull();
    // A value JSON cannot hold would not be stored as sent.
    expect(readBridgeMessage({ portego: 1, type: "set", key: "note" })).toBeNull();
    expect(readBridgeMessage({ portego: 1, type: "set", key: "note", value: 10n })).toBeNull();
  });
});

describe("readerIsActing", () => {
  test("refuses when the browser cannot tell whether the reader clicked", () => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, "userActivation");
    Object.defineProperty(navigator, "userActivation", { value: undefined, configurable: true });
    try {
      expect(readerIsActing()).toBe(false);
    } finally {
      if (descriptor) Object.defineProperty(navigator, "userActivation", descriptor);
      else delete (navigator as { userActivation?: unknown }).userActivation;
    }
  });
});
