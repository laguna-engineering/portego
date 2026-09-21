import { describe, expect, test } from "bun:test";
import { createEventBus } from "./bus.ts";

describe("the event bus", () => {
  test("reaches every subscriber, because each open page is one of them", () => {
    const bus = createEventBus();
    const first: string[] = [];
    const second: string[] = [];
    bus.subscribe((event) => first.push(event.type));
    bus.subscribe((event) => second.push(event.type));

    bus.publish({ type: "artifact.changed", id: "artifact-1" });

    expect(first).toEqual(["artifact.changed"]);
    expect(second).toEqual(["artifact.changed"]);
  });

  test("stops reaching a subscriber that let go, so a closed page costs nothing", () => {
    const bus = createEventBus();
    const seen: string[] = [];
    const unsubscribe = bus.subscribe((event) => seen.push(event.type));

    unsubscribe();
    bus.publish({ type: "artifact.changed", id: "artifact-1" });

    expect(seen).toEqual([]);
    expect(bus.size).toBe(0);
  });

  test("delivers to the rest when one subscriber throws", () => {
    const bus = createEventBus();
    const seen: string[] = [];
    bus.subscribe(() => {
      throw new Error("a broken stream");
    });
    bus.subscribe((event) => seen.push(event.type));

    // A failing listener must not become a failing write: publish happens
    // after the commit, and the caller is holding the response.
    expect(() => bus.publish({ type: "artifact.changed", id: "artifact-1" })).not.toThrow();
    expect(seen).toEqual(["artifact.changed"]);
  });

  test("survives a subscriber that unsubscribes while being notified", () => {
    const bus = createEventBus();
    const seen: string[] = [];
    const unsubscribe = bus.subscribe(() => unsubscribe());
    bus.subscribe((event) => seen.push(event.type));

    bus.publish({ type: "artifact.changed", id: "artifact-1" });

    expect(seen).toEqual(["artifact.changed"]);
    expect(bus.size).toBe(1);
  });
});
