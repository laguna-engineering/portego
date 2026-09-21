import { useCallback, useEffect, useRef, useState } from "react";
import { ArtifactPreview } from "./ArtifactPreview.tsx";
import { ArtifactText } from "./ArtifactText.tsx";
import {
  ApiError,
  type Artifact,
  fetchArtifact,
  setArtifactArchived,
  setArtifactStatus,
  sourceUrl,
} from "./api.ts";
import { Comments } from "./Comments.tsx";
import { formatBytes } from "./format.ts";
import { useLiveEvents } from "./live.ts";
import { RelativeTime } from "./RelativeTime.tsx";
import { artifactPath, fullScreenPath } from "./router.ts";

export type ArtifactDetailProps = {
  id: string;
  currentUserId: string;
  onBack: () => void;
  onFullScreen: () => void;
};

type State =
  | { status: "loading" }
  | { status: "ready"; artifact: Artifact }
  | { status: "error"; message: string; retryable: boolean };

export function ArtifactDetail({ id, currentUserId, onBack, onFullScreen }: ArtifactDetailProps) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [copied, setCopied] = useState(false);
  const request = useRef(0);
  const [view, setView] = useState<"preview" | "text">("preview");
  const [changing, setChanging] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function change(action: () => Promise<Artifact>) {
    setChanging(true);
    setProblem(null);
    try {
      setState({ status: "ready", artifact: await action() });
    } catch (error) {
      setProblem(error instanceof ApiError ? error.message : "That change did not go through.");
    } finally {
      setChanging(false);
    }
  }

  const load = useCallback(
    async (quiet = false) => {
      const attempt = ++request.current;
      if (!quiet) setState({ status: "loading" });
      try {
        const artifact = await fetchArtifact(id);
        // A slower earlier request must not overwrite a later one.
        if (attempt !== request.current) return;
        setState({ status: "ready", artifact });
      } catch (error) {
        if (attempt !== request.current) return;
        // A reload nobody asked for leaves the artifact on screen. The reader
        // is looking at it, and a background failure is not their problem.
        if (quiet) return;
        const api = error instanceof ApiError ? error : null;
        setState({
          status: "error",
          message:
            api?.status === 404 ? "That artifact does not exist." : "Could not load this artifact.",
          retryable: api?.status !== 404,
        });
      }
    },
    [id],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useLiveEvents((event) => {
    // The reader's own change is already on its way back with the new artifact.
    // Answering the announcement of it would race that response.
    if (changing) return;
    if (event.type === "reconnected" || (event.type === "artifact.changed" && event.id === id)) {
      void load(true);
    }
  });

  async function copyLink() {
    const link = new URL(artifactPath(id), window.location.origin).toString();
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copy this link", link);
    }
  }

  if (state.status === "loading") {
    return (
      <section className="detail">
        <p className="hint">Loading artifact...</p>
      </section>
    );
  }

  if (state.status === "error") {
    return (
      <section className="detail">
        <p role="alert">{state.message}</p>
        <div className="detail-actions">
          <button type="button" onClick={onBack}>
            Back to the gallery
          </button>
          {state.retryable ? (
            <button type="button" onClick={() => void load()}>
              Try again
            </button>
          ) : null}
        </div>
      </section>
    );
  }

  const { artifact } = state;
  return (
    <section className="detail">
      <button type="button" className="back" onClick={onBack}>
        ← All artifacts
      </button>

      <header className="detail-header">
        <h1>
          {artifact.title}
          {artifact.status === "solved" ? <span className="badge solved">solved</span> : null}
          {artifact.archivedAt ? <span className="badge">archived</span> : null}
        </h1>
        {artifact.description ? <p className="detail-description">{artifact.description}</p> : null}
        <p className="detail-meta">
          {artifact.creator.name} · <RelativeTime iso={artifact.createdAt} /> ·{" "}
          {formatBytes(artifact.byteSize)} ·{" "}
          <span className="filename">{artifact.originalFilename}</span>
        </p>
      </header>

      <div className="detail-actions">
        <a
          className="button"
          href={fullScreenPath(artifact.id)}
          rel="noopener noreferrer"
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
            event.preventDefault();
            onFullScreen();
          }}
        >
          Full screen
        </a>
        <a className="button" href={sourceUrl(artifact.id)} download={artifact.originalFilename}>
          Download source
        </a>
        <button type="button" onClick={() => void copyLink()}>
          {copied ? "Link copied" : "Copy link"}
        </button>
        <button
          type="button"
          disabled={changing}
          onClick={() =>
            void change(() =>
              setArtifactStatus(artifact.id, artifact.status === "solved" ? "open" : "solved"),
            )
          }
        >
          {artifact.status === "solved" ? "Reopen" : "Mark solved"}
        </button>
        <button
          type="button"
          disabled={changing}
          onClick={() => void change(() => setArtifactArchived(artifact.id, !artifact.archivedAt))}
        >
          {artifact.archivedAt ? "Restore" : "Archive"}
        </button>
      </div>

      {problem ? (
        <p className="problem" role="alert">
          {problem}
        </p>
      ) : null}

      <div className="views" role="tablist" aria-label="Artifact view">
        <button
          type="button"
          role="tab"
          aria-selected={view === "preview"}
          className={view === "preview" ? "view selected" : "view"}
          onClick={() => setView("preview")}
        >
          Preview
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "text"}
          className={view === "text" ? "view selected" : "view"}
          onClick={() => setView("text")}
        >
          Text
        </button>
      </div>

      {view === "preview" ? (
        <ArtifactPreview artifactId={artifact.id} title={artifact.title} />
      ) : (
        <ArtifactText artifactId={artifact.id} />
      )}

      <p className="digest">
        SHA-256 <code>{artifact.sha256}</code>
      </p>

      <Comments artifactId={artifact.id} currentUserId={currentUserId} />
    </section>
  );
}
