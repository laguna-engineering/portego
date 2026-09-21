import { useEffect, useId, useRef, useState } from "react";
import { ApiError, type Artifact, uploadArtifact } from "./api.ts";
import { formatBytes } from "./format.ts";

export type UploadDialogProps = {
  maxUploadBytes: number;
  onClose: () => void;
  onUploaded: (artifact: Artifact) => void;
};

function describeProblem(file: File, maxUploadBytes: number): string | null {
  if (file.size === 0) return "That file is empty.";
  if (file.size > maxUploadBytes) {
    return `That file is ${formatBytes(file.size)}. The limit is ${formatBytes(maxUploadBytes)}.`;
  }
  if (!/\.x?html?$/i.test(file.name)) {
    return "Choose a self-contained .html file.";
  }
  return null;
}

export function UploadDialog({ maxUploadBytes, onClose, onUploaded }: UploadDialogProps) {
  const titleId = useId();
  const fileId = useId();
  const descriptionId = useId();
  const headingId = useId();

  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dragging, setDragging] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    // Focus lands on the dialog itself, so a screen reader announces what
    // opened before the fields are read.
    dialog.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialog.current) return;

      // Tab stays inside the dialog. Everything behind it is inert while it is
      // open, so leaving would strand the focus ring somewhere unusable.
      const focusable = [
        ...dialog.current.querySelectorAll<HTMLElement>(
          'button, input, textarea, select, a[href], [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((element) => !element.hasAttribute("disabled"));
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      opener?.focus?.();
    };
  }, [onClose]);

  function choose(chosen: File | null) {
    setProblem(chosen ? describeProblem(chosen, maxUploadBytes) : null);
    setFile(chosen);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!file) {
      setProblem("Choose a file to upload.");
      return;
    }
    const rejected = describeProblem(file, maxUploadBytes);
    if (rejected) {
      setProblem(rejected);
      return;
    }

    setUploading(true);
    setProblem(null);
    try {
      const { artifact } = await uploadArtifact({ file, title, description });
      onUploaded(artifact);
    } catch (error) {
      setProblem(
        error instanceof ApiError ? error.message : "The upload did not finish. Try again.",
      );
      setUploading(false);
    }
  }

  return (
    <div className="overlay">
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        ref={dialog}
        tabIndex={-1}
      >
        <div className="dialog-header">
          <h2 id={headingId}>Upload an artifact</h2>
          <button type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <form onSubmit={submit}>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: the drop zone wraps a real file input. */}
          <div
            className={dragging ? "dropzone dragging" : "dropzone"}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              choose(event.dataTransfer.files.item(0));
            }}
          >
            <label htmlFor={fileId}>Drop a self-contained HTML file here, or choose one</label>
            <input
              id={fileId}
              type="file"
              accept=".html,.htm,text/html"
              disabled={uploading}
              onChange={(event) => choose(event.target.files?.item(0) ?? null)}
            />
          </div>

          {file ? (
            <p className="chosen">
              Ready to upload <strong>{file.name}</strong>, {formatBytes(file.size)}.
            </p>
          ) : null}

          <label htmlFor={titleId}>Title</label>
          <input
            id={titleId}
            value={title}
            disabled={uploading}
            placeholder="Taken from the document when left empty"
            onChange={(event) => setTitle(event.target.value)}
          />

          <label htmlFor={descriptionId}>Description (optional)</label>
          <textarea
            id={descriptionId}
            value={description}
            rows={3}
            disabled={uploading}
            onChange={(event) => setDescription(event.target.value)}
          />

          {problem ? (
            <p className="problem" role="alert">
              {problem}
            </p>
          ) : null}

          <div className="dialog-actions">
            <button type="button" onClick={onClose} disabled={uploading}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={uploading || !file}>
              {uploading ? `Uploading ${file?.name ?? ""}...` : "Upload"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
