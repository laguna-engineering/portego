import { useEffect, useState } from "react";
import { ApiError, fetchMarkdown } from "./api.ts";

export type ArtifactTextProps = {
  artifactId: string;
  /** The version to read. Null or omitted reads the current version. */
  versionId?: string | null;
};

type State =
  | { status: "loading" }
  | { status: "ready"; markdown: string; empty: boolean }
  | { status: "error"; message: string };

/**
 * The artifact's static content as text. The server parses the document
 * without running it, so an artifact that draws itself with JavaScript has
 * little or nothing to show here.
 */
export function ArtifactText({ artifactId, versionId = null }: ArtifactTextProps) {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    fetchMarkdown(artifactId, versionId)
      .then((result) => {
        if (!cancelled) setState({ status: "ready", ...result });
      })
      .catch((error: Error) => {
        if (cancelled) return;
        setState({
          status: "error",
          message: error instanceof ApiError ? error.message : "Could not read this artifact.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [artifactId, versionId]);

  if (state.status === "loading") return <p className="hint">Reading the document...</p>;
  if (state.status === "error") return <p role="alert">{state.message}</p>;
  if (state.empty) {
    return (
      <p className="hint">
        This artifact has no static text. Everything it shows is drawn by its own JavaScript, which
        only runs in the preview.
      </p>
    );
  }

  return <pre className="text-view">{state.markdown}</pre>;
}
