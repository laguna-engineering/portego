import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  ApiError,
  type Artifact,
  createFolder,
  createTag,
  type Folder,
  fetchFolders,
  fetchTags,
  setArtifactOrganization,
  type Tag,
} from "./api.ts";
import { folderPath, folderRows } from "./folders.ts";
import { TickIcon } from "./Icons.tsx";

type PickerProps = {
  artifact: Artifact;
  onChanged: (artifact: Artifact) => void;
  onClose: () => void;
};

function sameName(a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;
}

function useAction() {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    setProblem(null);
    try {
      await action();
    } catch (cause) {
      setProblem(cause instanceof ApiError ? cause.message : "That change did not go through.");
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, problem, run };
}

/**
 * A panel under the header's tools, with a search field that filters its
 * options and names a new one. Escape or a click anywhere else closes it.
 */
function Popover({
  label,
  placeholder,
  query,
  onQuery,
  onSubmit,
  onClose,
  children,
}: {
  label: string;
  placeholder: string;
  query: string;
  onQuery: (query: string) => void;
  onSubmit: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const close = useRef(onClose);

  useEffect(() => {
    close.current = onClose;
  });

  useEffect(() => {
    // On a phone the control that opened the panel was in the menu, which has closed.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    input.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit();
  }

  return (
    <>
      {/* Clicks on the artifact's frame never reach this document, so an element has to catch them. */}
      <button
        type="button"
        className="popover-backdrop"
        aria-hidden="true"
        tabIndex={-1}
        onClick={onClose}
      />
      <div className="popover" role="dialog" aria-label={label}>
        <form onSubmit={submit}>
          <label htmlFor={inputId}>{label}</label>
          <input
            ref={input}
            id={inputId}
            type="search"
            value={query}
            placeholder={placeholder}
            autoComplete="off"
            onChange={(event) => onQuery(event.target.value)}
          />
        </form>
        {children}
      </div>
    </>
  );
}

function Option({
  selected,
  disabled,
  indent = 0,
  onSelect,
  children,
}: {
  selected: boolean;
  disabled: boolean;
  indent?: number;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="popover-option"
      aria-pressed={selected}
      disabled={disabled}
      style={
        indent > 0
          ? { marginInlineStart: `${indent}rem`, width: `calc(100% - ${indent}rem)` }
          : undefined
      }
      onClick={onSelect}
    >
      <span className="popover-option-name">{children}</span>
      {selected ? <TickIcon /> : null}
    </button>
  );
}

export function FolderPicker({ artifact, onChanged, onClose }: PickerProps) {
  const [folders, setFolders] = useState<Folder[] | null>(null);
  const [query, setQuery] = useState("");
  const { busy, problem, run } = useAction();
  const currentId = artifact.folder?.id ?? null;

  useEffect(() => {
    void run(async () => setFolders(await fetchFolders()));
  }, [run]);

  const name = query.trim();
  const needle = name.toLocaleLowerCase();
  const rows =
    folders === null
      ? []
      : needle === ""
        ? folderRows(folders)
        : folders
            .filter((folder) => folder.name.toLocaleLowerCase().includes(needle))
            .map((folder) => ({ folder, depth: 0 }));
  // A new folder is created at the top level, where its name must be unique.
  const canCreate =
    folders !== null &&
    name !== "" &&
    !folders.some((folder) => folder.parentId === null && sameName(folder.name, name));

  function move(folderId: string | null) {
    if (folderId === currentId) {
      onClose();
      return;
    }
    void run(async () => {
      onChanged(await setArtifactOrganization(artifact.id, { folderId }));
      onClose();
    });
  }

  function create() {
    void run(async () => {
      const folder = await createFolder(name);
      setFolders((current) => [...(current ?? []), folder]);
      onChanged(await setArtifactOrganization(artifact.id, { folderId: folder.id }));
      onClose();
    });
  }

  return (
    <Popover
      label="Move to folder"
      placeholder="Find a folder"
      query={query}
      onQuery={setQuery}
      onSubmit={() => {
        if (canCreate) create();
        else if (rows.length === 1 && rows[0]) move(rows[0].folder.id);
      }}
      onClose={onClose}
    >
      {folders === null && !problem ? <p className="hint">Loading...</p> : null}
      {folders !== null ? (
        <div className="popover-options">
          {needle === "" ? (
            <Option selected={currentId === null} disabled={busy} onSelect={() => move(null)}>
              No folder
            </Option>
          ) : null}
          {rows.map(({ folder, depth }) => (
            <Option
              key={folder.id}
              selected={folder.id === currentId}
              disabled={busy}
              indent={depth}
              onSelect={() => move(folder.id)}
            >
              {needle === "" ? folder.name : folderPath(folder, folders)}
            </Option>
          ))}
          {canCreate ? (
            <Option selected={false} disabled={busy} onSelect={create}>
              Create “{name}”
            </Option>
          ) : null}
        </div>
      ) : null}
      {problem ? <p role="alert">{problem}</p> : null}
      <p className="hint">Type a new name to create a folder.</p>
    </Popover>
  );
}

export function TagPicker({ artifact, onChanged, onClose }: PickerProps) {
  const [tags, setTags] = useState<Tag[] | null>(null);
  const [query, setQuery] = useState("");
  const { busy, problem, run } = useAction();
  const applied = artifact.tags.map((tag) => tag.id);

  useEffect(() => {
    void run(async () => setTags(await fetchTags()));
  }, [run]);

  const name = query.trim();
  const needle = name.toLocaleLowerCase();
  const shown = (tags ?? []).filter((tag) => tag.name.toLocaleLowerCase().includes(needle));
  const canCreate = tags !== null && name !== "" && !tags.some((tag) => sameName(tag.name, name));

  // The panel stays open, so several tags can be changed in one visit.
  function toggle(tagId: string) {
    const tagIds = applied.includes(tagId)
      ? applied.filter((id) => id !== tagId)
      : [...applied, tagId];
    void run(async () => onChanged(await setArtifactOrganization(artifact.id, { tagIds })));
  }

  function create() {
    void run(async () => {
      const tag = await createTag(name);
      setTags((current) => [...(current ?? []), tag].sort((a, b) => a.name.localeCompare(b.name)));
      setQuery("");
      onChanged(await setArtifactOrganization(artifact.id, { tagIds: [...applied, tag.id] }));
    });
  }

  return (
    <Popover
      label="Tags"
      placeholder="Find a tag"
      query={query}
      onQuery={setQuery}
      onSubmit={() => {
        if (canCreate) create();
        else if (shown.length === 1 && shown[0]) toggle(shown[0].id);
      }}
      onClose={onClose}
    >
      {tags === null && !problem ? <p className="hint">Loading...</p> : null}
      {tags !== null ? (
        <div className="popover-options">
          {shown.map((tag) => (
            <Option
              key={tag.id}
              selected={applied.includes(tag.id)}
              disabled={busy}
              onSelect={() => toggle(tag.id)}
            >
              {tag.name}
            </Option>
          ))}
          {canCreate ? (
            <Option selected={false} disabled={busy} onSelect={create}>
              Create “{name}”
            </Option>
          ) : null}
        </div>
      ) : null}
      {problem ? <p role="alert">{problem}</p> : null}
      <p className="hint">Type a new name to create a tag.</p>
    </Popover>
  );
}
