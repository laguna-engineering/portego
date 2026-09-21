import { useState } from "react";
import type { Provider } from "./api.ts";

export type SignInProps = {
  providers: Provider[];
  /** Why the last attempt did not produce a session, if there was one. */
  refusal: string | null;
  onChoose: (providerId: string) => Promise<void>;
};

export function SignIn({ providers, refusal, onChoose }: SignInProps) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <main className="signin">
      <h1>portego</h1>
      <p>Sign in to browse and share artifacts.</p>

      {refusal ? <p role="alert">{refusal}</p> : null}
      {error ? <p role="alert">{error}</p> : null}

      {providers.length === 0 ? (
        <p>No sign-in provider is configured for this deployment.</p>
      ) : (
        <ul className="providers">
          {providers.map((provider) => (
            <li key={provider.id}>
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError(null);
                  try {
                    await onChoose(provider.id);
                  } catch (cause) {
                    setError((cause as Error).message);
                    setBusy(false);
                  }
                }}
              >
                Continue with {provider.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
