import { describe, expect, test } from "bun:test";
import { excerpt, formatBytes, formatRelativeTime } from "./format.ts";

describe("formatBytes", () => {
  test("keeps small files in bytes, where a decimal would be noise", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
  });

  test("moves to larger units so a size stays readable", () => {
    expect(formatBytes(1024)).toBe("1 KiB");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5 MiB");
  });
});

describe("formatRelativeTime", () => {
  const now = new Date("2026-09-10T12:00:00Z");

  test("describes recent uploads in the unit a person would use", () => {
    expect(formatRelativeTime("2026-09-10T11:30:00Z", now)).toContain("minute");
    expect(formatRelativeTime("2026-09-10T09:00:00Z", now)).toContain("hour");
    expect(formatRelativeTime("2026-09-08T12:00:00Z", now)).toContain("day");
  });

  test("stops at the minute, because the display only refreshes that often", () => {
    expect(formatRelativeTime("2026-09-10T11:59:59Z", now)).toBe("less than a minute ago");
    expect(formatRelativeTime("2026-09-10T11:59:01Z", now)).toBe("less than a minute ago");
    expect(formatRelativeTime("2026-09-10T11:59:00Z", now)).toContain("minute");
  });

  test("reads a clock a little ahead of the server as just now, not as the future", () => {
    expect(formatRelativeTime("2026-09-10T12:00:20Z", now)).toBe("less than a minute ago");
  });

  test("falls back to a date once relative time stops being useful", () => {
    expect(formatRelativeTime("2024-01-05T12:00:00Z", now)).not.toContain("ago");
  });
});

describe("excerpt", () => {
  test("collapses the whitespace a pasted description carries", () => {
    expect(excerpt("one\n\n  two")).toBe("one two");
  });

  test("cuts a long description and marks that it was cut", () => {
    const long = excerpt("a".repeat(200), 20);
    expect(long).toHaveLength(20);
    expect(long.endsWith("…")).toBe(true);
  });
});
