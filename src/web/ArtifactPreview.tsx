import { type Ref, useEffect, useState } from "react";
import { mintPreview } from "./api.ts";

export type ArtifactPreviewProps = {
  artifactId: string;
  title: string;
  className?: string;
  /** The version to preview. Null or omitted previews the current version. */
  versionId?: string | null;
  /** The frame itself, for the page that needs to talk to it. */
  ref?: Ref<HTMLIFrameElement>;
};

/**
 * Renders an uploaded artifact.
 *
 * The document comes from a different host over a short-lived signed URL, so
 * it never sees an application cookie. The `sandbox` attribute here and the
 * `Content-Security-Policy` on the response both withhold `allow-same-origin`,
 * which leaves the document in an opaque origin: it can run its own scripts
 * and reach nothing else.
 *
 * The full-screen view frames the artifact through this same component rather
 * than navigating to the preview URL. A sandboxed document that is itself the
 * top-level page can navigate its own tab anywhere, and no header prevents it.
 * A framed one cannot.
 */
export function ArtifactPreview({
  artifactId,
  title,
  className,
  versionId = null,
  ref,
}: ArtifactPreviewProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    setError(null);
    mintPreview(artifactId, versionId)
      .then((preview) => {
        if (!cancelled) setUrl(preview.url);
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      });
    return () => {
      cancelled = true;
    };
  }, [artifactId, versionId]);

  if (error) return <p role="alert">{error}</p>;
  if (!url) return <p>Loading preview...</p>;

  return (
    <iframe
      ref={ref}
      className={className ?? "preview"}
      title={`Preview of ${title}`}
      src={url}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
    />
  );
}
