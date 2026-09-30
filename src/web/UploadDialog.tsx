import { useEffect, useId, useRef, useState } from "react";
import {
  ApiError,
  type Artifact,
  createFolder,
  type Folder,
  fetchFolders,
  uploadArtifact,
} from "./api.ts";
import { folderPath, folderRows, sameName } from "./folders.ts";
import { formatBytes } from "./format.ts";

export type UploadDialogProps = {
  maxUploadBytes: number;
  /** The folder open in the gallery, which a new artifact is filed in by default. */
  initialFolderId?: string | null;
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

/** The select value that asks for a new folder. Folder ids never take this form. */
const NEW_FOLDER = "new-folder";

export function UploadDialog({
  maxUploadBytes,
  initialFolderId = null,
  onClose,
  onUploaded,
}: UploadDialogProps) {
  const titleId = useId();
  const fileId = useId();
  const descriptionId = useId();
  const folderId = useId();
  const newFolderId = useId();
  const headingId = useId();

  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [folders, setFolders] = useState<Folder[] | null>(null);
  const [folder, setFolder] = useState(initialFolderId ?? "");
  const [newFolderName, setNewFolderName] = useState("");
  const [onlyMe, setOnlyMe] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  // Set when the title belongs to an existing artifact, until the person
  // chooses a new version of it or a separate artifact.
  const [existingId, setExistingId] = useState<string | null>(null);

  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Without the list the upload still works, unfiled.
    fetchFolders()
      .then((loaded) => {
        setFolders(loaded);
        // A gallery URL can name a folder that has since been deleted.
        setFolder((current) => (loaded.some((entry) => entry.id === current) ? current : ""));
      })
      .catch(() => {
        setFolders([]);
        setFolder("");
      });
  }, []);

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
    setExistingId(null);
    setFile(chosen);
  }

  async function submit(
    event: React.FormEvent | null,
    target: { artifactId?: string; allowDuplicateTitle?: boolean } = {},
  ) {
    event?.preventDefault();
    if (!file) {
      setProblem("Choose a file to upload.");
      return;
    }
    const rejected = describeProblem(file, maxUploadBytes);
    if (rejected) {
      setProblem(rejected);
      return;
    }
    const creating = folder === NEW_FOLDER && !target.artifactId;
    if (creating && newFolderName.trim() === "") {
      setProblem("Name the new folder, or choose another one.");
      return;
    }

    setUploading(true);
    setProblem(null);
    setExistingId(null);
    try {
      // A new version keeps the folder and visibility its artifact already has.
      const chosen = creating ? await newFolder() : target.artifactId ? "" : folder;
      const filing = chosen ? { folderId: chosen } : {};
      const visibility = onlyMe && !target.artifactId ? { visibility: "private" as const } : {};
      const { artifact } = await uploadArtifact({
        file,
        title,
        description,
        ...filing,
        ...visibility,
        ...target,
      });
      onUploaded(artifact);
    } catch (error) {
      if (error instanceof ApiError && error.code === "TITLE_EXISTS" && error.artifactId) {
        setExistingId(error.artifactId);
        setProblem(
          "An artifact with this title already exists. Add this file to it as a new version, or upload it as a separate artifact.",
        );
      } else {
        setProblem(
          error instanceof ApiError ? error.message : "The upload did not finish. Try again.",
        );
      }
      setUploading(false);
    }
  }

  /**
   * Creates the named folder at the top level, or reuses one there with the
   * same name. It stays selected, so a retry after a refused upload files the
   * artifact in it rather than creating it again.
   */
  async function newFolder(): Promise<string> {
    const name = newFolderName.trim();
    let created = folders?.find((entry) => entry.parentId === null && sameName(entry.name, name));
    if (!created) {
      created = await createFolder(name);
      const added = created;
      setFolders((current) => [...(current ?? []), added]);
    }
    setFolder(created.id);
    setNewFolderName("");
    return created.id;
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
            onChange={(event) => {
              setExistingId(null);
              setTitle(event.target.value);
            }}
          />

          <label htmlFor={descriptionId}>Description (optional)</label>
          <textarea
            id={descriptionId}
            value={description}
            rows={3}
            disabled={uploading}
            onChange={(event) => setDescription(event.target.value)}
          />

          <label htmlFor={folderId}>Folder</label>
          <select
            id={folderId}
            value={folder}
            disabled={uploading || folders === null}
            onChange={(event) => setFolder(event.target.value)}
          >
            <option value="">No folder</option>
            {folders === null && folder ? <option value={folder}>Loading...</option> : null}
            {(folders ? folderRows(folders) : []).map((row) => (
              <option key={row.folder.id} value={row.folder.id}>
                {folderPath(row.folder, folders ?? [])}
              </option>
            ))}
            <option value={NEW_FOLDER}>New folder...</option>
          </select>

          {folder === NEW_FOLDER ? (
            <>
              <label htmlFor={newFolderId}>New folder name</label>
              <input
                id={newFolderId}
                value={newFolderName}
                maxLength={100}
                disabled={uploading}
                onChange={(event) => setNewFolderName(event.target.value)}
              />
            </>
          ) : null}

          <label className="toggle">
            <input
              type="checkbox"
              checked={onlyMe}
              disabled={uploading}
              onChange={(event) => setOnlyMe(event.target.checked)}
            />
            Private: only you can see it
          </label>

          {problem ? (
            <p className="problem" role="alert">
              {problem}
            </p>
          ) : null}

          <div className="dialog-actions">
            <button type="button" onClick={onClose} disabled={uploading}>
              Cancel
            </button>
            {existingId && !uploading ? (
              <>
                <button type="button" onClick={() => submit(null, { allowDuplicateTitle: true })}>
                  Upload as a separate artifact
                </button>
                <button
                  type="button"
                  className="primary"
                  onClick={() => submit(null, { artifactId: existingId })}
                >
                  Add as a new version
                </button>
              </>
            ) : (
              <button type="submit" className="primary" disabled={uploading || !file}>
                {uploading ? `Uploading ${file?.name ?? ""}...` : "Upload"}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
