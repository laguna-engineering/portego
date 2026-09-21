import { useEffect, useState } from "react";
import { ApiError, decideConsent, fetchOAuthClient } from "./api.ts";

export type McpConsentProps = {
  /** The signed OAuth query, passed through untouched. */
  query: string;
};

const SCOPE_LABELS: Record<string, string> = {
  "artifacts:read": "List and read shared artifacts",
  "artifacts:write": "Upload new artifacts as you",
  offline_access: "Stay signed in until a week passes without use",
};

export function McpConsent({ query }: McpConsentProps) {
  const parameters = new URLSearchParams(query);
  const clientId = parameters.get("client_id") ?? "";
  const scopes = (parameters.get("scope") ?? "").split(" ").filter(Boolean);

  const [clientName, setClientName] = useState(clientId);
  const [problem, setProblem] = useState<string | null>(null);
  const [deciding, setDeciding] = useState(false);

  useEffect(() => {
    if (!clientId) return;
    let cancelled = false;
    fetchOAuthClient(clientId)
      .then((client) => {
        if (!cancelled && client.clientName) setClientName(client.clientName);
      })
      // A client that cannot be read is still shown, by its id.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  async function decide(accept: boolean) {
    setDeciding(true);
    setProblem(null);
    try {
      window.location.assign(await decideConsent({ accept, oauthQuery: query }));
    } catch (error) {
      setProblem(
        error instanceof ApiError ? error.message : "That authorization request did not complete.",
      );
      setDeciding(false);
    }
  }

  if (!clientId) {
    return (
      <section className="signin">
        <h1>Authorize</h1>
        <p role="alert">This authorization link is incomplete. Start again from your MCP client.</p>
      </section>
    );
  }

  return (
    <section className="signin">
      <h1>Authorize {clientName}</h1>
      <p>
        <strong>{clientName}</strong> is asking to use this service as you.
      </p>

      <ul className="scopes">
        {scopes.map((scope) => (
          <li key={scope}>{SCOPE_LABELS[scope] ?? scope}</li>
        ))}
      </ul>

      {scopes.length === 0 ? <p>It asked for no particular access.</p> : null}
      {problem ? <p role="alert">{problem}</p> : null}

      <div className="dialog-actions">
        <button type="button" disabled={deciding} onClick={() => void decide(false)}>
          Deny
        </button>
        <button
          type="button"
          className="primary"
          disabled={deciding}
          onClick={() => void decide(true)}
        >
          {deciding ? "Working..." : "Allow"}
        </button>
      </div>
    </section>
  );
}
