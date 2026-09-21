import { beforeEach, describe, expect, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { type LiveEvent, useLiveEvents } from "./live.ts";
import { StubEventSource } from "./testing.ts";

beforeEach(() => StubEventSource.install());

function stream(): StubEventSource {
  const open = StubEventSource.last;
  if (!open) throw new Error("No stream was opened");
  return open;
}

describe("the change stream", () => {
  test("opens once however many parts of the page are listening", () => {
    const first = renderHook(() => useLiveEvents(() => {}));
    const second = renderHook(() => useLiveEvents(() => {}));

    expect(StubEventSource.open).toHaveLength(1);
    expect(stream().url).toBe("/api/events");

    first.unmount();
    expect(StubEventSource.open).toHaveLength(1);

    // The last listener leaving is what closes it. A connection held open for
    // a page nobody is looking at costs the server a slot.
    second.unmount();
    expect(StubEventSource.open).toHaveLength(0);
  });

  test("opens nothing for a visitor with no session", () => {
    renderHook(() => useLiveEvents(() => {}, false));
    expect(StubEventSource.open).toHaveLength(0);
  });

  test("hands every listener what the server announced", () => {
    const seen: LiveEvent[] = [];
    const other: LiveEvent[] = [];
    renderHook(() => useLiveEvents((event) => seen.push(event)));
    renderHook(() => useLiveEvents((event) => other.push(event)));

    act(() => stream().send({ type: "artifact.created", id: "artifact-1" }));

    expect(seen).toEqual([{ type: "artifact.created", id: "artifact-1" }]);
    expect(other).toEqual(seen);
  });

  test("says a break happened, so a listener can refetch what it missed", () => {
    const seen: LiveEvent[] = [];
    renderHook(() => useLiveEvents((event) => seen.push(event)));

    // The first connection has nothing to catch up on.
    act(() => stream().connect());
    expect(seen).toEqual([]);

    act(() => stream().fail());
    act(() => stream().connect());
    expect(seen).toEqual([{ type: "reconnected" }]);
  });

  test("ignores a frame it cannot read rather than failing the page", () => {
    const seen: LiveEvent[] = [];
    renderHook(() => useLiveEvents((event) => seen.push(event)));

    act(() => stream().onmessage?.({ data: "not json" }));

    expect(seen).toEqual([]);
  });

  test("calls the handler the component rendered last", () => {
    const seen: string[] = [];
    let label = "first";
    const { rerender } = renderHook(() => useLiveEvents(() => seen.push(label)));

    label = "second";
    rerender();
    act(() => stream().send({ type: "artifact.changed", id: "artifact-1" }));

    expect(seen).toEqual(["second"]);
  });
});
