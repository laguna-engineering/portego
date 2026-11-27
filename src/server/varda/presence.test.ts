import { describe, expect, test } from "bun:test";
import { createVardaPresence } from "./presence.ts";

describe("Varda's presence", () => {
  test("a page sees Varda connected from the first stream on", () => {
    let changes = 0;
    const presence = createVardaPresence({ graceMs: 20, onChange: () => changes++ });
    expect(presence.connected()).toBe(false);
    presence.open();
    expect(presence.connected()).toBe(true);
    expect(changes).toBe(1);
  });

  test("a reconnect inside the grace period does not show Varda as gone", async () => {
    let changes = 0;
    const presence = createVardaPresence({ graceMs: 50, onChange: () => changes++ });
    const close = presence.open();
    close();
    expect(presence.connected()).toBe(true);
    await Bun.sleep(10);
    presence.open();
    await Bun.sleep(80);
    expect(presence.connected()).toBe(true);
    expect(changes).toBe(1);
  });

  test("a stream that replaces another does not show Varda as gone", async () => {
    let changes = 0;
    const presence = createVardaPresence({ graceMs: 20, onChange: () => changes++ });
    const first = presence.open();
    const second = presence.open();
    first();
    await Bun.sleep(40);
    expect(presence.connected()).toBe(true);
    second();
    second();
    await Bun.sleep(40);
    expect(presence.connected()).toBe(false);
    expect(changes).toBe(2);
  });

  test("Varda counts as gone once the grace period passes with no stream", async () => {
    let changes = 0;
    const presence = createVardaPresence({ graceMs: 20, onChange: () => changes++ });
    presence.open()();
    await Bun.sleep(40);
    expect(presence.connected()).toBe(false);
    expect(changes).toBe(2);
  });
});
