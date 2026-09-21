import { afterEach, describe, expect, jest, test } from "bun:test";
import { act, render, screen } from "@testing-library/react";
import { RelativeTime } from "./RelativeTime.tsx";

const START = new Date("2026-09-10T12:00:00Z");

function hide(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

afterEach(() => {
  hide(false);
  jest.useRealTimers();
});

describe("RelativeTime", () => {
  test("moves on by itself, so a page left open does not freeze its times", () => {
    jest.useFakeTimers();
    jest.setSystemTime(START);
    render(<RelativeTime iso="2026-09-10T11:59:40Z" />);
    expect(screen.getByText("less than a minute ago")).toBeDefined();

    act(() => {
      jest.advanceTimersByTime(3 * 60_000);
    });
    expect(screen.getByText(/3 minutes ago/)).toBeDefined();
  });

  test("keeps the exact time reachable, because the text is rounded", () => {
    jest.setSystemTime(START);
    render(<RelativeTime iso="2026-09-10T11:00:00Z" />);
    const element = screen.getByText(/hour/);

    expect(element.getAttribute("datetime")).toBe("2026-09-10T11:00:00Z");
    expect(element.getAttribute("title")).toBe(new Date("2026-09-10T11:00:00Z").toLocaleString());
  });

  test("runs one timer however many times the page shows", () => {
    jest.useFakeTimers();
    jest.setSystemTime(START);
    const timers = jest.spyOn(globalThis, "setTimeout");

    render(
      <>
        <RelativeTime iso="2026-09-10T11:00:00Z" />
        <RelativeTime iso="2026-09-10T10:00:00Z" />
        <RelativeTime iso="2026-09-10T09:00:00Z" />
      </>,
    );

    expect(timers.mock.calls.length).toBe(1);
    timers.mockRestore();
  });

  test("holds the timer while the tab is hidden and catches up on return", () => {
    jest.useFakeTimers();
    jest.setSystemTime(START);
    render(<RelativeTime iso="2026-09-10T11:59:40Z" />);

    hide(true);
    const timers = jest.spyOn(globalThis, "setTimeout");
    act(() => {
      jest.advanceTimersByTime(10 * 60_000);
    });
    expect(timers.mock.calls.length).toBe(0);
    expect(screen.getByText("less than a minute ago")).toBeDefined();

    hide(false);
    expect(screen.getByText(/10 minutes ago/)).toBeDefined();
    timers.mockRestore();
  });
});
