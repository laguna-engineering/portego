import { type ReactNode, useEffect, useMemo, useState } from "react";
import { ApiError, type ArtifactVersion, fetchMarkdown, type Markdown } from "./api.ts";
import { HighlightIcon, SideBySideIcon } from "./Icons.tsx";
import { type DiffRow, diffRows, type Segment } from "./versionDiff.ts";

export type ArtifactDiffProps = {
  artifactId: string;
  /** Every version of the artifact, for the two selects. */
  versions: ArtifactVersion[];
  from: ArtifactVersion;
  to: ArtifactVersion;
  onSelect: (pair: { fromId: string; toId: string }) => void;
  onClose: () => void;
};

type Mode = "inline" | "split";

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

  let body: ReactNode;
  if (state.status === "loading") {
    body = <p className="hint">Comparing versions...</p>;
  } else if (state.status === "error") {
    body = <p role="alert">{state.message}</p>;
  } else if (state.before.empty && state.after.empty) {
    body = (
      <p className="hint">
        These versions have no static text. Everything they show is drawn by their own JavaScript,
        so there is nothing to compare.
      </p>
    );
  } else if (!rows.some((row) => row.changed)) {
    body = <p className="hint">The text of these versions is the same.</p>;
  } else if (mode === "inline") {
    body = <InlineDiff rows={rows} />;
  } else {
    body = <SplitDiff rows={rows} />;
  }

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
  return (
    <pre className="text-view diff-inline">
      {rows.map((row, index) =>
        row.right ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows never reorder
          <span key={index}>
            <Segments segments={row.right} Mark="ins" />
            {"\n"}
          </span>
        ) : null,
      )}
    </pre>
  );
}

function SplitDiff({ rows }: { rows: DiffRow[] }) {
  return (
    <div className="diff-split">
      {rows.map((row, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows never reorder
        <div key={index} className="diff-row">
          <pre className={row.left ? "diff-cell" : "diff-cell missing"}>
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
