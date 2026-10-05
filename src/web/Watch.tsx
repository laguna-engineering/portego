import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  type Folder,
  fetchFolders,
  fetchSubscription,
  type Subscription,
  type SubscriptionLevel,
  type SubscriptionTarget,
  setSubscription,
} from "./api.ts";
import { EyeIcon, TickIcon } from "./Icons.tsx";
import { useLiveEvents } from "./live.ts";

export const WATCH_LEVELS: { level: SubscriptionLevel; name: string; description: string }[] = [
  {
    level: "all",
    name: "All activity",
    description: "Versions, comments, status changes, and entries",
  },
  { level: "versions", name: "New versions only", description: "Skip comments and entries" },
  { level: "none", name: "Not watching", description: "Only replies to your own comments" },
];

/** The level in force: the target's own, else the nearest folder's above it. */
export function effectiveLevel(subscription: Subscription | null): SubscriptionLevel {
  return subscription?.level ?? subscription?.inherited?.level ?? "none";
}

export function watchLabel(level: SubscriptionLevel, idle = "Watch"): string {
  if (level === "all") return "Watching";
  if (level === "versions") return "Watching versions";
  return idle;
}

/**
 * The reader's subscription to `target`. It loads again when `reloadKey`
 * changes, e.g. after a comment that may have followed the artifact again.
 */
export function useSubscription(target: SubscriptionTarget | null, reloadKey?: unknown) {
  const [subscription, setLoaded] = useState<Subscription | null>(null);
  const kind = target?.kind;
  const id = target?.id;

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey only triggers a reload.
  useEffect(() => {
    if (!kind || !id) {
      setLoaded(null);
      return;
    }
    let current = true;
    fetchSubscription({ kind, id }).then(
      (found) => {
        if (current) setLoaded(found);
      },
      () => {
        // The control shows the last level it knew. Choosing one tries again.
      },
    );
    return () => {
      current = false;
    };
  }, [kind, id, reloadKey]);

  const choose = useCallback(
    async (level: SubscriptionLevel) => {
      if (!kind || !id) return;
      setLoaded(await setSubscription({ kind, id }, level));
    },
    [kind, id],
  );

  return { subscription, choose };
}

/** The levels to choose from, under the control that opened it. */
export function WatchPopover({
  label,
  subscription,
  note,
  onChoose,
  onClose,
}: {
  label: string;
  subscription: Subscription | null;
  /** What a subscription covers, e.g. a folder's subfolders. */
  note?: string;
  onChoose: (level: SubscriptionLevel) => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  const current = effectiveLevel(subscription);

  useEffect(() => {
    close.current = onClose;
  });

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.querySelector<HTMLButtonElement>("[aria-pressed='true']")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  async function pick(level: SubscriptionLevel) {
    setBusy(true);
    setProblem(null);
    try {
      await onChoose(level);
      onClose();
    } catch (cause) {
      setProblem(cause instanceof ApiError ? cause.message : "That change did not go through.");
    } finally {
      setBusy(false);
    }
  }

  const inherited = subscription?.level === null ? subscription.inherited : null;

  return (
    <>
      <button
        type="button"
        className="popover-backdrop"
        aria-hidden="true"
        tabIndex={-1}
        onClick={onClose}
      />
      <div ref={panel} className="popover watch" role="dialog" aria-label={label}>
        <div className="popover-options">
          {WATCH_LEVELS.map(({ level, name, description }) => (
            <button
              key={level}
              type="button"
              className="popover-option watch-option"
              aria-pressed={level === current}
              disabled={busy}
              onClick={() => void pick(level)}
            >
              <span className="watch-option-text">
                <span>{name}</span>
                <span className="hint">{description}</span>
              </span>
              {level === current ? <TickIcon /> : null}
            </button>
          ))}
        </div>
        {inherited ? <p className="hint">Set by the {inherited.folder.name} folder.</p> : null}
        {note ? <p className="hint">{note}</p> : null}
        {problem ? <p role="alert">{problem}</p> : null}
      </div>
    </>
  );
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** What watching `folder` covers, counted from the folders the reader can see. */
function coverage(folder: Folder, folders: Folder[]): string {
  const below = new Set([folder.id]);
  let artifacts = folder.artifactCount;
  let grew = true;
  while (grew) {
    grew = false;
    for (const other of folders) {
      if (other.parentId && below.has(other.parentId) && !below.has(other.id)) {
        below.add(other.id);
        artifacts += other.artifactCount;
        grew = true;
      }
    }
  }
  const subfolders = below.size - 1;
  const where =
    subfolders === 0 ? folder.name : `${folder.name} and its ${plural(subfolders, "subfolder")}`;
  return `Covers ${plural(artifacts, "artifact")} in ${where}, and anything added later.`;
}

/** The selected folder's name, with its parents, and the control to watch it. */
export function FolderWatch({ folderId }: { folderId: string }) {
  const [folders, setFolders] = useState<Folder[] | null>(null);
  const [open, setOpen] = useState(false);
  const { subscription, choose } = useSubscription({ kind: "folders", id: folderId });
  const level = effectiveLevel(subscription);

  const load = useCallback(() => {
    fetchFolders().then(setFolders, () => {
      // The name stays as it was. The next folder change tries again.
    });
  }, []);

  useEffect(load, [load]);

  useLiveEvents((event) => {
    if (event.type === "folder.changed" || event.type === "artifact.changed") load();
  });

  const byId = new Map((folders ?? []).map((folder) => [folder.id, folder]));
  const folder = byId.get(folderId);
  if (!folders || !folder) return null;
  const parents: string[] = [];
  for (let parent = folder.parentId; parent; parent = byId.get(parent)?.parentId ?? null) {
    parents.unshift(byId.get(parent)?.name ?? "");
  }

  return (
    <div className="folder-watch">
      <h2 className="folder-watch-name" title={[...parents, folder.name].join(" › ")}>
        {parents.length > 0 ? (
          <span className="folder-watch-parents">{parents.join(" › ")} › </span>
        ) : null}
        {folder.name}
      </h2>
      <div className="folder-watch-control">
        <button
          type="button"
          className="icon-button"
          aria-expanded={open}
          data-active={level !== "none" || undefined}
          onClick={() => setOpen((current) => !current)}
        >
          <EyeIcon />
          <span>{watchLabel(level, "Watch folder")}</span>
        </button>
        {open ? (
          <WatchPopover
            label="Watch folder"
            subscription={subscription}
            note={coverage(folder, folders)}
            onChoose={choose}
            onClose={() => setOpen(false)}
          />
        ) : null}
      </div>
    </div>
  );
}
