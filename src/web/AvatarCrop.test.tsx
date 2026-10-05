import { describe, expect, test } from "bun:test";
import { clampOffset, minZoom, placement, VIEWPORT } from "./AvatarCrop.tsx";

// 1000 x 500 is twice as wide as it is tall. At zoom 1 its height fills the
// 256-pixel frame, so it is shown at 512 x 256.
const WIDE = { width: 1000, height: 500 };

describe("crop", () => {
  test("starts on the middle square of the image", () => {
    expect(placement(WIDE, 1, { x: 0, y: 0 })).toEqual({ x: -128, y: 0, width: 512, height: 256 });
  });

  test("zooms out until the whole of a landscape image fits in the frame", () => {
    const zoom = minZoom(WIDE);
    expect(placement(WIDE, zoom, { x: 0, y: 0 })).toEqual({
      x: 0,
      y: 64,
      width: VIEWPORT,
      height: 128,
    });
    // A portrait image fits the same way, turned around.
    expect(placement({ width: 500, height: 1000 }, zoom, { x: 0, y: 0 })).toMatchObject({
      x: 64,
      width: 128,
      height: VIEWPORT,
    });
  });

  test("never lets an image that covers the frame open an empty edge", () => {
    const offset = clampOffset(WIDE, 1, { x: 500, y: 50 });
    // The left edge stops at the frame's left edge, and the height just fits,
    // so it cannot move vertically.
    expect(offset).toEqual({ x: 128, y: 0 });
    expect(placement(WIDE, 1, offset).x).toBe(0);

    const right = placement(WIDE, 1, clampOffset(WIDE, 1, { x: -500, y: 0 }));
    expect(right.x + right.width).toBe(VIEWPORT);
  });

  test("keeps a zoomed-out image wholly inside the frame", () => {
    const zoom = minZoom(WIDE);
    const top = placement(WIDE, zoom, clampOffset(WIDE, zoom, { x: 0, y: -500 }));
    expect(top.y).toBe(0);
    const bottom = placement(WIDE, zoom, clampOffset(WIDE, zoom, { x: 0, y: 500 }));
    expect(bottom.y + bottom.height).toBe(VIEWPORT);
  });

  test("zooming in keeps the image centred on the same point", () => {
    const box = placement(WIDE, 2, { x: 0, y: 0 });
    expect(box.x + box.width / 2).toBe(VIEWPORT / 2);
    expect(box.y + box.height / 2).toBe(VIEWPORT / 2);
    expect(clampOffset(WIDE, 2, { x: 0, y: 1000 }).y).toBe((512 - VIEWPORT) / 2);
  });
});
