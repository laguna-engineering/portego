import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ApiError, type ArtifactVersion, fetchMarkdown, type Markdown } from "./api.ts";
import { HighlightIcon, SideBySideIcon } from "./Icons.tsx";
import { changeRuns, type DiffRow, diffRows, type Segment } from "./versionDiff.ts";

type Mode = "inline" | "split";

export type ArtifactDiffProps = {
  artifactId: string;
  /** Every version of the artifact, for the two selects. */
  versions: ArtifactVersion[];
  from: ArtifactVersion;
  to: ArtifactVersion;
  onSelect: (pair: { fromId: string; toId: string }) => void;
  onClose: () => void;
};

type State =
  | { status: "loading" }
  | { status: "ready"; before: Markdown; after: Markdown }
  | { status: "error"; message: string };

/**
 * The difference between the Markdown of two versions, either inline (the
 * newer text with what is new or changed highlighted) or side by side.
 */
export function ArtifactDiff({
  artifactId,
  versions,
  from,
  to,
  onSelect,
  onClose,
}: ArtifactDiffProps) {
  const [mode, setMode] = useState<Mode>("inline");
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    Promise.all([fetchMarkdown(artifactId, from.id), fetchMarkdown(artifactId, to.id)])
      .then(([before, after]) => {
        if (!cancelled) setState({ status: "ready", before, after });
      })
      .catch((error: Error) => {
        if (cancelled) return;
        setState({
          status: "error",
          message: error instanceof ApiError ? error.message : "Could not compare these versions.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [artifactId, from.id, to.id]);

  const rows = useMemo(
    () => (state.status === "ready" ? diffRows(state.before.markdown, state.after.markdown) : []),
    [state],
  );

  const options = versions.map((version) => (
    <option key={version.id} value={version.id}>
      v{version.number}
    </option>
  ));

  let message: ReactNode = null;
  if (state.status === "loading") {
    message = <p className="hint">Comparing versions...</p>;
  } else if (state.status === "error") {
    message = <p role="alert">{state.message}</p>;
  } else if (state.before.empty && state.after.empty) {
    message = (
      <p className="hint">
        These versions have no static text. Everything they show is drawn by their own JavaScript,
        so there is nothing to compare.
      </p>
    );
  } else if (!rows.some((row) => row.changed)) {
    message = <p className="hint">The text of these versions is the same.</p>;
  }
  const body = message ? (
    <div className="diff-scroll">{message}</div>
  ) : (
    <DiffWithMinimap rows={rows} mode={mode} />
  );

  return (
    <section className="diff" aria-label="Changes between versions">
      <div className="diff-controls">
        <div className="diff-title">
          Changes from{" "}
          <select
            aria-label="From version"
            value={from.id}
            onChange={(event) => onSelect({ fromId: event.target.value, toId: to.id })}
          >
            {options}
          </select>{" "}
          to{" "}
          <select
            aria-label="To version"
            value={to.id}
            onChange={(event) => onSelect({ fromId: from.id, toId: event.target.value })}
          >
            {options}
          </select>
          <button type="button" className="icon-button" onClick={onClose}>
            Close comparison
          </button>
        </div>
        <fieldset className="chips">
          <legend>Show changes</legend>
          {(["inline", "split"] as const).map((value) => (
            <button
              key={value}
              type="button"
              className="icon-button icon-only"
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
            >
              {value === "inline" ? <HighlightIcon /> : <SideBySideIcon />}
              <span>{value === "inline" ? "Highlight changes" : "Side by side"}</span>
            </button>
          ))}
        </fieldset>
      </div>
      {body}
    </section>
  );
}

/** A run's place in the scrolled content, as fractions of its height. */
type Position = { top: number; height: number };

function showViewport(scroller: HTMLElement | null, viewport: HTMLElement | null) {
  if (!scroller || !viewport || !scroller.scrollHeight) return;
  viewport.style.top = `${(scroller.scrollTop / scroller.scrollHeight) * 100}%`;
  viewport.style.height = `${(scroller.clientHeight / scroller.scrollHeight) * 100}%`;
}

/**
 * The diff in its own scroll area, with a strip beside it that marks where
 * each run of changes sits and scrolls to it when clicked.
 */
function DiffWithMinimap({ rows, mode }: { rows: DiffRow[]; mode: Mode }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const runs = useMemo(() => changeRuns(rows), [rows]);
  const [positions, setPositions] = useState<Position[]>([]);
  // Measuring runs on every resize, so the rows must not render again with it.
  const diff = useMemo(
    () => (mode === "inline" ? <InlineDiff rows={rows} /> : <SplitDiff rows={rows} />),
    [rows, mode],
  );

  // Lines wrap, so positions come from the layout, not from row indices.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const measure = () => {
      const total = scroller.scrollHeight;
      const origin = scroller.getBoundingClientRect().top - scroller.scrollTop;
      const elements = new Map<string, Element>();
      for (const element of scroller.querySelectorAll("[data-row]")) {
        elements.set(element.getAttribute("data-row") ?? "", element);
      }
      const edge = (index: number, side: "top" | "bottom") =>
        elements.get(String(index))?.getBoundingClientRect()[side] ?? origin;
      setPositions(
        runs.map((run) => {
          if (!total) return { top: 0, height: 0 };
          const top = edge(run.first, "top") - origin;
          const bottom = edge(run.last, "bottom") - origin;
          return { top: top / total, height: (bottom - top) / total };
        }),
      );
      showViewport(scroller, viewportRef.current);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    if (scroller.firstElementChild) observer.observe(scroller.firstElementChild);
    return () => observer.disconnect();
  }, [runs]);

  const scrollTo = (position: Position | undefined) => {
    const scroller = scrollRef.current;
    if (!scroller || !position) return;
    scroller.scrollTo({ top: position.top * scroller.scrollHeight - scroller.clientHeight / 3 });
  };

  return (
    <div className="diff-main">
      <div
        className="diff-scroll"
        ref={scrollRef}
        onScroll={() => showViewport(scrollRef.current, viewportRef.current)}
      >
        {diff}
      </div>
      <nav className="diff-minimap" aria-label="Changes">
        <div className="diff-minimap-viewport" ref={viewportRef} />
        {runs.map((run, index) => (
          <button
            key={run.first}
            type="button"
            className={`diff-minimap-mark ${run.kind}`}
            style={{
              top: `${(positions[index]?.top ?? 0) * 100}%`,
              height: `${(positions[index]?.height ?? 0) * 100}%`,
            }}
            aria-label={`Change ${index + 1} of ${runs.length}, ${run.kind}`}
            onClick={() => scrollTo(positions[index])}
          />
        ))}
      </nav>
    </div>
  );
}

function Segments({ segments, Mark }: { segments: Segment[]; Mark: "ins" | "del" }) {
  return segments.map((segment, index) =>
    segment.changed ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: segments never reorder
      <Mark key={index}>{segment.text}</Mark>
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: segments never reorder
      <span key={index}>{segment.text}</span>
    ),
  );
}

function InlineDiff({ rows }: { rows: DiffRow[] }) {
  // A removed line renders as an empty span, so the minimap can place its marker.
  return (
    <pre className="text-view diff-inline">
      {rows.map((row, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows never reorder
        <span key={index} data-row={index}>
          {row.right ? (
            <>
              <Segments segments={row.right} Mark="ins" />
              {"\n"}
            </>
          ) : null}
        </span>
      ))}
    </pre>
  );
}

function SplitDiff({ rows }: { rows: DiffRow[] }) {
  return (
    <div className="diff-split">
      {rows.map((row, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows never reorder
        <div key={index} className="diff-row">
          <pre className={row.left ? "diff-cell" : "diff-cell missing"} data-row={index}>
            {row.left ? <Segments segments={row.left} Mark="del" /> : null}
          </pre>
          <pre className={row.right ? "diff-cell" : "diff-cell missing"}>
            {row.right ? <Segments segments={row.right} Mark="ins" /> : null}
          </pre>
        </div>
      ))}
    </div>
  );
}
