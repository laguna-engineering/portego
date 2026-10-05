import { type KeyboardEvent, type PointerEvent, useEffect, useId, useRef, useState } from "react";
import { useModal } from "./modal.ts";

/** What the server accepts. */
export const AVATAR_MAX_BYTES = 1024 * 1024;

/** The side of the square frame in the dialog, in CSS pixels. */
export const VIEWPORT = 256;
/** The side of the saved image. Twice the frame, so it stays sharp on a dense screen. */
export const OUTPUT = 512;
export const MAX_ZOOM = 4;
const KEY_STEP = 8;

export type Size = { width: number; height: number };
/** Where the image's centre sits relative to the frame's centre, in CSS pixels. */
export type Offset = { x: number; y: number };

/**
 * Zoom 1 is where the image just covers the frame. The lowest zoom is where
 * the whole image just fits inside it.
 */
export function minZoom(image: Size): number {
  return Math.min(image.width, image.height) / Math.max(image.width, image.height);
}

/** The image's box in the frame, in CSS pixels from the frame's top left corner. */
export function placement(image: Size, zoom: number, offset: Offset) {
  const scale = (VIEWPORT / Math.min(image.width, image.height)) * zoom;
  const width = image.width * scale;
  const height = image.height * scale;
  return {
    x: VIEWPORT / 2 + offset.x - width / 2,
    y: VIEWPORT / 2 + offset.y - height / 2,
    width,
    height,
  };
}

/**
 * An image larger than the frame always covers it, so dragging never opens an
 * empty edge. One smaller than the frame always stays wholly inside it.
 */
export function clampOffset(image: Size, zoom: number, offset: Offset): Offset {
  const { width, height } = placement(image, zoom, offset);
  const maxX = Math.abs(width - VIEWPORT) / 2;
  const maxY = Math.abs(height - VIEWPORT) / 2;
  return {
    x: Math.min(maxX, Math.max(-maxX, offset.x)),
    y: Math.min(maxY, Math.max(-maxY, offset.y)),
  };
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("The canvas gave no image."))),
      type,
      quality,
    ),
  );
}

export function AvatarCropDialog({
  file,
  onCancel,
  onSave,
}: {
  file: File;
  onCancel: () => void;
  /** Receives the cropped square. The dialog stays busy until the promise settles. */
  onSave: (image: Blob) => Promise<void>;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number; origin: Offset } | null>(null);
  const headingId = useId();
  const [url, setUrl] = useState<string | null>(null);
  const [size, setSize] = useState<Size | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 });
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useModal(dialog, onCancel);

  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  const move = (next: Offset) => {
    if (size) setOffset(clampOffset(size, zoom, next));
  };

  const changeZoom = (next: number) => {
    if (!size) return;
    // Zooms about the frame's centre, so what is in the middle stays there.
    const ratio = next / zoom;
    setZoom(next);
    setOffset(clampOffset(size, next, { x: offset.x * ratio, y: offset.y * ratio }));
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      origin: offset,
    };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start || start.pointerId !== event.pointerId) return;
    move({
      x: start.origin.x + event.clientX - start.x,
      y: start.origin.y + event.clientY - start.y,
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step: Record<string, Offset> = {
      ArrowLeft: { x: -KEY_STEP, y: 0 },
      ArrowRight: { x: KEY_STEP, y: 0 },
      ArrowUp: { x: 0, y: -KEY_STEP },
      ArrowDown: { x: 0, y: KEY_STEP },
    };
    const delta = step[event.key];
    if (!delta) return;
    event.preventDefault();
    move({ x: offset.x + delta.x, y: offset.y + delta.y });
  };

  const save = async () => {
    if (!size || !image.current) return;
    setSaving(true);
    let cropped: Blob;
    try {
      const box = placement(size, zoom, offset);
      const ratio = OUTPUT / VIEWPORT;
      const draw = (background: string | null) => {
        const canvas = document.createElement("canvas");
        canvas.width = OUTPUT;
        canvas.height = OUTPUT;
        const context = canvas.getContext("2d");
        if (!context || !image.current) throw new Error("No 2D canvas.");
        if (background) {
          context.fillStyle = background;
          context.fillRect(0, 0, OUTPUT, OUTPUT);
        }
        context.imageSmoothingQuality = "high";
        // Drawn whole and clipped by the canvas, which every browser does the
        // same way, unlike a source rectangle that reaches past the image.
        context.drawImage(
          image.current,
          box.x * ratio,
          box.y * ratio,
          box.width * ratio,
          box.height * ratio,
        );
        return canvas;
      };
      // Space the image leaves uncovered stays transparent, so it shows the
      // avatar's own background.
      cropped = await toBlob(draw(null), "image/png");
      // A busy photo can stay over the limit as a PNG. JPEG has no
      // transparency, so the uncovered space gets the avatar's colour instead.
      if (cropped.size > AVATAR_MAX_BYTES) {
        const mark = getComputedStyle(document.documentElement).getPropertyValue("--mark-1");
        cropped = await toBlob(draw(mark.trim()), "image/jpeg", 0.9);
      }
    } catch {
      setProblem("Could not prepare the image. Try another file.");
      setSaving(false);
      return;
    }
    await onSave(cropped);
  };

  const shown = size ? placement(size, zoom, offset) : null;

  return (
    <div className="overlay">
      <div
        className="dialog avatar-crop"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        ref={dialog}
        tabIndex={-1}
      >
        <div className="dialog-header">
          <h2 id={headingId}>Position your avatar</h2>
          <button type="button" onClick={onCancel} aria-label="Close">
            ×
          </button>
        </div>

        <div className="avatar-crop-body">
          {/* biome-ignore lint/a11y/useSemanticElements: a fieldset cannot take focus for the arrow keys. */}
          <div
            className="avatar-crop-frame"
            style={{ width: VIEWPORT, height: VIEWPORT }}
            role="group"
            aria-label="Image position. Drag, or use the arrow keys, to move it."
            // biome-ignore lint/a11y/noNoninteractiveTabindex: the arrow keys move the image, so the frame takes focus.
            tabIndex={0}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={() => {
              drag.current = null;
            }}
            onPointerCancel={() => {
              drag.current = null;
            }}
            onKeyDown={onKeyDown}
          >
            {url ? (
              <img
                ref={image}
                src={url}
                alt=""
                draggable={false}
                style={
                  shown
                    ? {
                        width: shown.width,
                        height: shown.height,
                        left: shown.x,
                        top: shown.y,
                      }
                    : { visibility: "hidden" }
                }
                onLoad={(event) =>
                  setSize({
                    width: event.currentTarget.naturalWidth,
                    height: event.currentTarget.naturalHeight,
                  })
                }
                onError={() => setProblem("Your browser cannot read this image. Try another file.")}
              />
            ) : null}
          </div>

          <div className="avatar-crop-controls">
            <label htmlFor={`${headingId}-zoom`}>Zoom</label>
            <input
              id={`${headingId}-zoom`}
              type="range"
              min={size ? minZoom(size) : 1}
              max={MAX_ZOOM}
              step={0.01}
              value={zoom}
              disabled={!size}
              onChange={(event) => changeZoom(Number(event.target.value))}
            />
            <button type="button" disabled={!size} onClick={() => move({ x: 0, y: 0 })}>
              Center
            </button>
          </div>
        </div>

        {problem ? (
          <p className="problem" role="alert">
            {problem}
          </p>
        ) : null}

        <div className="dialog-actions">
          <button type="button" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
          <button type="button" className="primary" disabled={!size || saving} onClick={save}>
            {saving ? "Saving..." : "Save avatar"}
          </button>
        </div>
      </div>
    </div>
  );
}
