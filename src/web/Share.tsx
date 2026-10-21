import { useEffect, useRef, useState } from "react";
import {
  ApiError,
  type Artifact,
  createShareLink,
  fetchShareLink,
  revokeShareLink,
  setArtifactVisibility,
} from "./api.ts";
import { TickIcon } from "./Icons.tsx";

type Audience = "private" | "shared" | "link";

const AUDIENCES: { audience: Audience; name: string; description: string }[] = [
  { audience: "private", name: "Only me", description: "Nobody else can see it." },
  {
    audience: "shared",
    name: "Everyone signed in",
    description: "Everyone who can sign in here can see it.",
  },
  {
    audience: "link",
    name: "Anyone with the link",
    description: "Everyone signed in, and anyone you send the link to, without signing in.",
  },
];

function audienceOf(artifact: Artifact): Audience {
  if (artifact.visibility === "private") return "private";
  return artifact.publicLink ? "link" : "shared";
}

/** Who can see the artifact, chosen by its creator under the Share control. */
export function SharePopover({
  artifact,
  privateArtifacts,
  onChanged,
  onClose,
}: {
  artifact: Artifact;
  privateArtifacts: boolean;
  onChanged: (artifact: Artifact) => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  const current = audienceOf(artifact);

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

  // The link is a secret, so the artifact does not carry it; the creator asks for it.
  useEffect(() => {
    if (!artifact.publicLink) {
      setUrl(null);
      return;
    }
    let active = true;
    fetchShareLink(artifact.id)
      .then((link) => {
        if (active) setUrl(link);
      })
      .catch(() => {
        if (active) setProblem("Could not load the link.");
      });
    return () => {
      active = false;
    };
  }, [artifact.id, artifact.publicLink]);

  async function run(action: () => Promise<Artifact>) {
    setBusy(true);
    setProblem(null);
    try {
      onChanged(await action());
    } catch (cause) {
      setProblem(cause instanceof ApiError ? cause.message : "That change did not go through.");
    } finally {
      setBusy(false);
    }
  }

  function choose(audience: Audience) {
    if (audience === current) return;
    void run(async () => {
      if (audience === "link") {
        const created = await createShareLink(artifact.id);
        setUrl(created.url);
        return created.artifact;
      }
      if (audience === "private") return setArtifactVisibility(artifact.id, "private");
      return current === "link"
        ? revokeShareLink(artifact.id)
        : setArtifactVisibility(artifact.id, "shared");
    });
  }

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copy this link", url);
    }
  }

  return (
    <>
      <button
        type="button"
        className="popover-backdrop"
        aria-hidden="true"
        tabIndex={-1}
        onClick={onClose}
      />
      <div ref={panel} className="popover share" role="dialog" aria-label="Share">
        <div className="popover-options">
          {AUDIENCES.filter(({ audience }) => privateArtifacts || audience !== "private").map(
            ({ audience, name, description }) => (
              <button
                key={audience}
                type="button"
                className="popover-option share-option"
                aria-pressed={audience === current}
                disabled={busy}
                onClick={() => choose(audience)}
              >
                <span className="share-option-text">
                  <span>{name}</span>
                  <span className="hint">{description}</span>
                </span>
                {audience === current ? <TickIcon /> : null}
              </button>
            ),
          )}
        </div>
        {current === "link" ? (
          <div className="share-link">
            <input
              type="text"
              readOnly
              aria-label="Public link"
              value={url ?? ""}
              onFocus={(event) => event.currentTarget.select()}
            />
            <div className="share-link-actions">
              <button type="button" disabled={!url} onClick={() => void copy()}>
                {copied ? "Link copied" : "Copy link"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => revokeShareLink(artifact.id))}
              >
                Revoke link
              </button>
            </div>
            <p className="hint">Revoking stops this link working. A new link is a different one.</p>
          </div>
        ) : null}
        {problem ? <p role="alert">{problem}</p> : null}
      </div>
    </>
  );
}
