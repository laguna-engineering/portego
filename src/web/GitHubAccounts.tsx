import { useEffect, useState } from "react";
import { Avatar } from "./Avatar.tsx";
import {
  ApiError,
  disconnectGitHubAccount,
  fetchGitHubAccounts,
  type GitHubAccount,
  startGitHubConnection,
} from "./api.ts";
import { CheckIcon } from "./Icons.tsx";

const DATE_FORMAT = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

type Status =
  | { kind: "connected"; login: string | null }
  | { kind: "disconnected"; login: string }
  | { kind: "problem"; message: string };

/** Better Auth's `error` code, as the person who just came back from GitHub reads it. */
function connectionProblem(code: string | null): string {
  if (code === "access_denied")
    return "Access was not granted on GitHub. No account was connected.";
  if (code === "account_already_linked_to_different_user") {
    return "That GitHub account is connected to someone else's Portego account. No account was connected.";
  }
  return "GitHub did not finish connecting. No account was connected. Please try again.";
}

/** What the URL says about a connection that just ended, if one did. */
function returnedStatus(): Status | null {
  const params = new URLSearchParams(window.location.search);
  const result = params.get("github");
  if (result === "connected") return { kind: "connected", login: null };
  if (result === "error")
    return { kind: "problem", message: connectionProblem(params.get("error")) };
  return null;
}

export function GitHubAccounts() {
  const [accounts, setAccounts] = useState<GitHubAccount[] | null>(null);
  const [status, setStatus] = useState<Status | null>(returnedStatus);
  const [opening, setOpening] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Keep the message but drop it from the URL, so a reload does not repeat it.
    const params = new URLSearchParams(window.location.search);
    if (!params.has("github")) return;
    params.delete("github");
    params.delete("error");
    params.delete("error_description");
    const search = params.size > 0 ? `?${params}` : "";
    window.history.replaceState(null, "", `${window.location.pathname}${search}`);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchGitHubAccounts()
      .then((loaded) => {
        if (cancelled) return;
        setAccounts(loaded);
        // Connecting an account that was already connected updates it rather
        // than adding one, so the latest change is the one that just happened.
        const latest = loaded.reduce<GitHubAccount | null>(
          (newest, account) => (newest && newest.updatedAt >= account.updatedAt ? newest : account),
          null,
        );
        setStatus((current) =>
          current?.kind === "connected"
            ? { kind: "connected", login: latest?.login ?? null }
            : current,
        );
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setAccounts([]);
        setStatus({
          kind: "problem",
          message:
            error instanceof ApiError ? error.message : "Could not load your GitHub accounts.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const connect = async () => {
    setOpening(true);
    setConfirming(null);
    setStatus(null);
    try {
      window.location.assign(await startGitHubConnection());
    } catch (error) {
      setOpening(false);
      setStatus({
        kind: "problem",
        message: error instanceof ApiError ? error.message : "Could not open GitHub.",
      });
    }
  };

  const disconnect = async (account: GitHubAccount) => {
    setBusy(true);
    try {
      setAccounts(await disconnectGitHubAccount(account.id));
      setStatus({ kind: "disconnected", login: account.login });
      setConfirming(null);
    } catch (error) {
      setStatus({
        kind: "problem",
        message: error instanceof ApiError ? error.message : "Could not disconnect the account.",
      });
    } finally {
      setBusy(false);
    }
  };

  const has = accounts !== null && accounts.length > 0;

  return (
    <section className="profile-github" aria-labelledby="github-accounts-heading">
      <h2 id="github-accounts-heading">GitHub</h2>

      {status?.kind === "connected" && status.login ? (
        <p className="github-status" role="status">
          <CheckIcon />
          <span>
            Connected <strong>{status.login}</strong>.
          </span>
        </p>
      ) : null}
      {status?.kind === "disconnected" ? (
        <p className="hint profile-note" role="status">
          Disconnected <strong>{status.login}</strong>. You can connect it again at any time.
        </p>
      ) : null}
      {status?.kind === "problem" ? (
        <p className="problem" role="alert">
          {status.message}
        </p>
      ) : null}

      {has ? (
        <ul className="github-accounts">
          {accounts.map((account) =>
            confirming === account.id ? (
              <li key={account.id} className="github-account confirming">
                <p>
                  Disconnect <strong>{account.login}</strong> from Portego? You can connect it again
                  at any time.
                </p>
                <div className="github-account-actions">
                  <button type="button" disabled={busy} onClick={() => setConfirming(null)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="primary"
                    disabled={busy}
                    onClick={() => void disconnect(account)}
                  >
                    Disconnect
                  </button>
                </div>
              </li>
            ) : (
              <li key={account.id} className="github-account">
                <Avatar email={account.login} src={null} />
                <div className="github-account-name">
                  <a href={`https://github.com/${account.login}`} target="_blank" rel="noreferrer">
                    {account.login}
                  </a>
                  <span className="github-account-since">
                    Connected {DATE_FORMAT.format(account.connectedAt)}
                  </span>
                </div>
                <button
                  type="button"
                  aria-label={`Disconnect ${account.login}`}
                  onClick={() => {
                    setConfirming(account.id);
                    setStatus(null);
                  }}
                >
                  Disconnect
                </button>
              </li>
            ),
          )}
        </ul>
      ) : null}

      {accounts !== null && !has && !status && !opening ? (
        <p className="hint profile-note">No GitHub account connected.</p>
      ) : null}

      {accounts === null ? null : opening ? (
        <div className="github-connect">
          <button type="button" disabled>
            Opening GitHub…
          </button>
        </div>
      ) : has ? (
        <div className="github-connect">
          <button type="button" className="github-connect-more" onClick={() => void connect()}>
            Connect another account
          </button>
        </div>
      ) : (
        <div className="github-connect">
          <button type="button" onClick={() => void connect()}>
            Connect GitHub account
          </button>
        </div>
      )}

      {accounts !== null && !has ? (
        <p className="hint profile-note">
          Connecting opens GitHub so you can approve access. You can disconnect at any time.
        </p>
      ) : null}
    </section>
  );
}
