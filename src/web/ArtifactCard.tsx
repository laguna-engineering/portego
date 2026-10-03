import { type DragEvent, useEffect, useRef } from "react";
import type { Artifact } from "./api.ts";
import { excerpt, formatBytes } from "./format.ts";
import { TickIcon } from "./Icons.tsx";
import { RelativeTime } from "./RelativeTime.tsx";
import { artifactPath } from "./router.ts";

/**
 * The drag data type that carries artifact ids to a folder in the library.
 * Several ids are joined with commas, which ids never contain.
 */
export const ARTIFACT_DRAG_TYPE = "application/x-portego-artifact";

/** How long a press lasts before it selects the card. */
export const LONG_PRESS_MS = 500;

/** How far, in pixels, the pointer can move during a press before it stops counting. */
const PRESS_SLOP = 8;

export type ArtifactCardProps = {
  artifact: Artifact;
  onOpen: (id: string) => void;
  /** The selected artifact ids, in the order they were selected. */
  selection: readonly string[];
  onToggleSelected: (id: string) => void;
  /** A drag that carried the whole selection was dropped somewhere. */
  onSelectionMoved: () => void;
};

/**
 * A stable mark color for one artifact, from the four flat sage tokens. The
 * card shows a generated mark rather than a rendering of the upload: no
 * artifact markup enters this DOM.
 */
function mark(id: string): string {
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) % 997;
  return `var(--mark-${(hash % 4) + 1})`;
}

/** Drags a copy of the card with a count of the other artifacts on it. */
function showDragCount(event: DragEvent<HTMLAnchorElement>, others: number) {
  const card = event.currentTarget.parentElement;
  if (!card) return;
  const box = card.getBoundingClientRect();
  const image = card.cloneNode(true) as HTMLElement;
  image.classList.add("card-drag-image");
  image.style.width = `${box.width}px`;
  const count = document.createElement("span");
  count.className = "card-drag-count";
  count.textContent = `+ ${others} ${others === 1 ? "other" : "others"}`;
  image.append(count);
  // The browser takes its picture of the element during this event, so it can go right after.
  document.body.append(image);
  event.dataTransfer.setDragImage(image, event.clientX - box.left, event.clientY - box.top);
  window.setTimeout(() => image.remove());
}

export function ArtifactCard({
  artifact,
  onOpen,
  selection,
  onToggleSelected,
  onSelectionMoved,
}: ArtifactCardProps) {
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  // The click that ends a long press must not open the artifact or toggle it again.
  const longPressed = useRef(false);
  const draggedAll = useRef(false);
  const selected = selection.includes(artifact.id);
  const selecting = selection.length > 0;

  function cancelPress() {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  }

  useEffect(
    () => () => {
      if (press.current) window.clearTimeout(press.current.timer);
    },
    [],
  );

  return (
    <li className={selected ? "card selected" : "card"}>
      <a
        className="card-link"
        href={artifactPath(artifact.id)}
        rel="noopener noreferrer"
        onPointerDown={(event) => {
          longPressed.current = false;
          // While selecting, a click already toggles the card.
          if (event.button !== 0 || selecting) return;
          press.current = {
            x: event.clientX,
            y: event.clientY,
            timer: window.setTimeout(() => {
              press.current = null;
              longPressed.current = true;
              onToggleSelected(artifact.id);
            }, LONG_PRESS_MS),
          };
        }}
        onPointerMove={(event) => {
          const start = press.current;
          if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > PRESS_SLOP) {
            cancelPress();
          }
        }}
        onPointerUp={cancelPress}
        onPointerLeave={cancelPress}
        onPointerCancel={cancelPress}
        onContextMenu={(event) => {
          // A long touch opens the context menu in some browsers.
          if (press.current || longPressed.current) event.preventDefault();
        }}
        onClick={(event) => {
          if (longPressed.current) {
            longPressed.current = false;
            event.preventDefault();
            return;
          }
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
          event.preventDefault();
          if (selecting) onToggleSelected(artifact.id);
          else onOpen(artifact.id);
        }}
        onDragStart={(event) => {
          cancelPress();
          const ids = selected
            ? [artifact.id, ...selection.filter((id) => id !== artifact.id)]
            : [artifact.id];
          draggedAll.current = ids.length > 1;
          event.dataTransfer.setData(ARTIFACT_DRAG_TYPE, ids.join(","));
          // A link allows only copy and link by default. The library drop is a move.
          event.dataTransfer.effectAllowed = "all";
          if (ids.length > 1) showDragCount(event, ids.length - 1);
        }}
        onDragEnd={(event) => {
          if (draggedAll.current && event.dataTransfer.dropEffect !== "none") onSelectionMoved();
          draggedAll.current = false;
        }}
      >
        <span
          className="card-mark"
          aria-hidden="true"
          style={selected ? undefined : { background: mark(artifact.id) }}
        >
          {selected ? <TickIcon /> : artifact.title.slice(0, 2).toUpperCase()}
        </span>
        <span className="card-body">
          <span className="card-title">
            {artifact.title}
            {selected ? <span className="card-selected">, selected</span> : null}
            {artifact.versionCount > 1 ? (
              <span className="badge">v{artifact.versionCount}</span>
            ) : null}
            {artifact.status === "solved" ? <span className="badge solved">solved</span> : null}
            {artifact.archivedAt ? <span className="badge">archived</span> : null}
            {artifact.visibility === "private" ? <span className="badge">private</span> : null}
          </span>
          {artifact.description ? (
            <span className="card-description">{excerpt(artifact.description, 110)}</span>
          ) : null}
          <span className="card-meta">
            {artifact.creator.name} · created <RelativeTime iso={artifact.createdAt} />
            {artifact.updatedAt !== artifact.createdAt ? (
              <>
                {" "}
                · updated <RelativeTime iso={artifact.updatedAt} />
              </>
            ) : null}{" "}
            · {formatBytes(artifact.byteSize)}
          </span>
        </span>
      </a>
    </li>
  );
}
