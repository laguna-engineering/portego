import { describe, expect, test } from "bun:test";
import { readBridgeMessage } from "./preview-bridge.ts";

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

  test("accepts a post up to the comment length limit and refuses a longer one whole", () => {
    expect(readBridgeMessage({ portego: 1, type: "post", body: "x".repeat(4000) })).toEqual({
      type: "post",
      body: "x".repeat(4000),
    });
    expect(readBridgeMessage({ portego: 1, type: "post", body: "x".repeat(4001) })).toBeNull();
    expect(readBridgeMessage({ portego: 1, type: "post", body: { type: "vote" } })).toBeNull();
  });

  test("ignores a message of a type the bridge does not know", () => {
    expect(readBridgeMessage({ portego: 1, type: "eval" })).toBeNull();
  });
});
