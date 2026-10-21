import { type FormEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ApiError,
  clearSharedEntry,
  type Entry,
  fetchSharedArtifact,
  fetchSharedEntries,
  type Guest,
  joinAsGuest,
  type SharedArtifact as Shared,
  setSharedEntry,
} from "./api.ts";
import { useModal } from "./modal.ts";
import {
  type BridgeMessage,
  openFromPreview,
  type PageEntry,
  readerIsActing,
  sendToPreview,
  showFragment,
  toPageEntry,
  usePreviewBridge,
} from "./preview-bridge.ts";
import { artifactPath } from "./router.ts";

type Change = { key: string; value: unknown } | { key: string; clear: true };

/** Where this browser keeps the name it gave on one link. */
function guestStorageKey(token: string): string {
  return `portego-guest:${token}`;
}

function storedGuest(token: string): Guest | null {
  try {
    const raw = window.localStorage.getItem(guestStorageKey(token));
    return raw ? (JSON.parse(raw) as Guest) : null;
  } catch {
    return null;
  }
}

function storeGuest(token: string, guest: Guest | null): void {
  try {
    if (guest) window.localStorage.setItem(guestStorageKey(token), JSON.stringify(guest));
    else window.localStorage.removeItem(guestStorageKey(token));
  } catch {
    // Without storage the name lasts until the page closes.
  }
}

/**
 * An artifact opened with its public link, by someone who may have no
 * session. It shows the artifact and its entries. A reader who adds an entry
 * gives a name first, which this browser keeps for this link.
 */
export function SharedArtifact({ token }: { token: string }) {
  const [shared, setShared] = useState<Shared | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [guest, setGuest] = useState<Guest | null>(() => storedGuest(token));
  /** The write waiting for the reader's name. */
  const [pending, setPending] = useState<Change | null>(null);
  const [recorded, setRecorded] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    let active = true;
    fetchSharedArtifact(token)
      .then((result) => {
        if (!active) return;
        if (result.artifactId) {
          window.location.replace(artifactPath(result.artifactId) + window.location.hash);
          return;
        }
        setShared(result);
      })
      .catch((cause) => {
        if (!active) return;
        if (cause instanceof ApiError && cause.status === 404) setMissing(true);
        else setError(cause instanceof Error ? cause.message : "Could not load the artifact.");
      });
    return () => {
      active = false;
    };
  }, [token]);

  useEffect(() => {
    if (shared) document.title = shared.artifact.title;
  }, [shared]);

  const loadEntries = useCallback(async () => {
    try {
      setEntries((await fetchSharedEntries(token)).entries);
    } catch {
      // The artifact still shows. Its page sees the entries it had.
    }
  }, [token]);

  // There is no live stream without a session, so a returning reader reloads.
  useEffect(() => {
    if (!shared) return;
    void loadEntries();
    const onVisible = () => {
      if (document.visibilityState === "visible") void loadEntries();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [shared, loadEntries]);

  const pageEntries = useMemo((): PageEntry[] => entries.map(toPageEntry), [entries]);

  useEffect(() => {
    sendToPreview(frameRef.current, { type: "entries", entries: pageEntries });
  }, [pageEntries]);

  const write = useCallback(
    async (as: Guest, change: Change) => {
      setProblem(null);
      try {
        if ("clear" in change) await clearSharedEntry(token, as, change.key);
        else await setSharedEntry(token, as, change.key, change.value);
        setRecorded("clear" in change ? `Removed ${change.key}` : `Saved ${change.key}`);
        await loadEntries();
      } catch (cause) {
        // A token the server no longer accepts asks for the name again next time.
        if (cause instanceof ApiError && cause.status === 401) {
          storeGuest(token, null);
          setGuest(null);
        }
        setProblem(cause instanceof ApiError ? cause.message : "Could not save that entry.");
      }
    },
    [token, loadEntries],
  );

  const handleBridgeMessage = useCallback(
    (message: BridgeMessage) => {
      if (message.type === "ready") {
        sendToPreview(frameRef.current, { type: "comments", comments: [] });
        sendToPreview(frameRef.current, { type: "entries", entries: pageEntries });
      } else if (message.type === "open") {
        openFromPreview(message.url);
      } else if (message.type === "hash") {
        showFragment(message.hash);
      } else if (message.type === "set" || message.type === "clear") {
        if (!readerIsActing()) return;
        const change: Change =
          message.type === "set"
            ? { key: message.key, value: message.value }
            : { key: message.key, clear: true };
        if (guest) void write(guest, change);
        else setPending(change);
      }
    },
    [pageEntries, guest, write],
  );

  usePreviewBridge(frameRef, handleBridgeMessage);

  useEffect(() => {
    if (!recorded) return;
    const timer = window.setTimeout(() => setRecorded(null), 2500);
    return () => window.clearTimeout(timer);
  }, [recorded]);

  async function join(name: string) {
    const joined = await joinAsGuest(token, name);
    storeGuest(token, joined);
    setGuest(joined);
    const change = pending;
    setPending(null);
    if (change) await write(joined, change);
  }

  if (missing) {
    return (
      <main className="shell">
        <h1>This link does not work</h1>
        <p>It may have been revoked. Ask the person who sent it for a new one.</p>
      </main>
    );
  }
  if (error) {
    return (
      <main className="shell">
        <p role="alert">{error}</p>
      </main>
    );
  }
  if (!shared) {
    return (
      <main className="shell">
        <p className="hint">Loading...</p>
      </main>
    );
  }

  return (
    <div className="full">
      <header className="masthead shared-header">
        <div className="full-name">
          <h1 title={shared.artifact.title}>{shared.artifact.title}</h1>
          <p className="hint">Shared by {shared.artifact.creator.name}</p>
        </div>
        {guest ? (
          <p className="hint">
            Adding as {guest.name}.{" "}
            <button
              type="button"
              className="link"
              onClick={() => {
                storeGuest(token, null);
                setGuest(null);
              }}
            >
              Change name
            </button>
          </p>
        ) : null}
        {problem ? (
          <p className="problem" role="alert">
            {problem}
          </p>
        ) : null}
      </header>
      <div className="full-body">
        <iframe
          ref={frameRef}
          className="preview-full"
          title={`Preview of ${shared.artifact.title}`}
          src={shared.preview.url + window.location.hash}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
        />
        {recorded ? (
          <p className="recorded-notice" role="status">
            {recorded}
          </p>
        ) : null}
      </div>
      {pending ? <GuestNameDialog onSubmit={join} onClose={() => setPending(null)} /> : null}
    </div>
  );
}

/** Asks for the name the reader's entries show under. */
function GuestNameDialog({
  onSubmit,
  onClose,
}: {
  onSubmit: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const headingId = useId();
  useModal(dialog, onClose);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      await onSubmit(name);
    } catch (cause) {
      setProblem(cause instanceof ApiError ? cause.message : "That did not go through.");
      setBusy(false);
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
          <h2 id={headingId}>What is your name?</h2>
          <button type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <form onSubmit={submit}>
          <label>
            Your name
            <input
              type="text"
              value={name}
              maxLength={80}
              required
              autoComplete="name"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <p className="hint">
            Everyone who can see this artifact sees your name next to what you add.
          </p>
          {problem ? <p role="alert">{problem}</p> : null}
          <button type="submit" disabled={busy || name.trim() === ""}>
            Continue
          </button>
        </form>
      </div>
    </div>
  );
}
