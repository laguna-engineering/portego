import { useCallback, useEffect, useState } from "react";
import { ArtifactFull } from "./ArtifactFull.tsx";
import type { Provider } from "./api.ts";
import {
  ApiError,
  fetchProviders,
  fetchSession,
  type Session,
  signOut,
  startSignIn,
} from "./api.ts";
import { Gallery } from "./Gallery.tsx";
import { UploadIcon } from "./Icons.tsx";
import { Library } from "./Library.tsx";
import { useLiveEvents } from "./live.ts";
import { Masthead } from "./Masthead.tsx";
import { McpConsent } from "./McpConsent.tsx";
import { McpLogin } from "./McpLogin.tsx";
import { artifactPath, galleryPath, useRoute } from "./router.ts";
import { SignIn } from "./SignIn.tsx";
import { UploadDialog } from "./UploadDialog.tsx";

type State =
  | { status: "loading" }
  | { status: "signed-out"; providers: Provider[] }
  | { status: "signed-in"; session: Session }
  | { status: "error"; message: string };

/** Why the callback sent the browser back without a session. */
function refusalMessage(code: string | null): string | null {
  if (!code) return null;
  if (code === "NOT_ADMITTED" || code === "access_denied") {
    return "That account is not allowed to use this service.";
  }
  return "Sign-in did not complete. Please try again.";
}

export function App() {
  const { route, navigate } = useRoute();
  const [state, setState] = useState<State>({ status: "loading" });
  const [refusal, setRefusal] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const error = params.get("error");
    if (!error) return;
    setRefusal(refusalMessage(error));
    // Keep the message but drop it from the URL, so a reload does not repeat it.
    params.delete("error");
    params.delete("error_description");
    const search = params.size > 0 ? `?${params}` : "";
    window.history.replaceState(null, "", `${window.location.pathname}${search}`);
  }, []);

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const session = await fetchSession();
      if (session) {
        setState({ status: "signed-in", session });
        return;
      }
      setState({ status: "signed-out", providers: await fetchProviders() });
    } catch (error) {
      setState({
        status: "error",
        message: error instanceof ApiError ? error.message : "Could not reach the server.",
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Holding the stream here keeps one connection open for the whole visit.
  // Without it, every move between the gallery and an artifact would close the
  // last listener's connection and open another. Signing out drops it.
  useLiveEvents(() => {}, state.status === "signed-in");

  if (state.status === "loading") {
    return (
      <main className="shell">
        <p className="hint">Loading...</p>
      </main>
    );
  }

  if (state.status === "error") {
    return (
      <main className="shell">
        <p role="alert">{state.message}</p>
        <button type="button" onClick={() => void load()}>
          Try again
        </button>
      </main>
    );
  }

  if (state.status === "signed-out") {
    // Sign-in comes back to the page that was asked for. An artifact link sent
    // to someone with no session lands on the artifact, and an interrupted MCP
    // authorization resumes where it stopped. An unknown path has nothing to
    // return to.
    const returnTo =
      route.name === "unknown" ? "/" : `${window.location.pathname}${window.location.search}`;
    return (
      <SignIn
        providers={state.providers}
        refusal={refusal}
        onChoose={async (id) => {
          window.location.assign(await startSignIn(id, returnTo));
        }}
      />
    );
  }

  const { session } = state;

  const handleSignOut = async () => {
    await signOut();
    await load();
    navigate("/");
  };

  const masthead = (
    <Masthead
      email={session.user.email}
      onHome={() => navigate("/")}
      onSignOut={handleSignOut}
      menu={
        route.name === "gallery"
          ? (close) => (
              <button
                type="button"
                className="menu-row"
                onClick={() => {
                  close();
                  setUploading(true);
                }}
              >
                <UploadIcon />
                Upload an artifact
              </button>
            )
          : undefined
      }
    />
  );

  // The artifact view gives the artifact every pixel the masthead does not
  // need. The masthead carries the artifact's own chrome there, so the view
  // renders it itself.
  if (route.name === "artifact") {
    return (
      <ArtifactFull
        id={route.id}
        email={session.user.email}
        currentUserId={session.user.id}
        onHome={() => navigate("/")}
        onSignOut={handleSignOut}
      />
    );
  }

  // The masthead sits outside the column so it spans the window on every page,
  // which is the width it has on the artifact view. Moving between the two
  // leaves it where it was.
  return (
    <>
      {masthead}

      <main className={route.name === "gallery" ? "shell wide" : "shell"}>
        {route.name === "gallery" ? (
          <div className="library-layout">
            <Library
              folderId={route.folderId}
              tagIds={route.tagIds}
              onFilter={(filters) => navigate(galleryPath({ ...route, ...filters }))}
            />
            <Gallery
              filters={route}
              onFilter={(filters, options) =>
                navigate(galleryPath({ ...route, ...filters }), {
                  replace: options?.replace ?? false,
                })
              }
              onOpen={(id) => navigate(artifactPath(id))}
              onUpload={() => setUploading(true)}
            />
          </div>
        ) : null}

        {route.name === "mcp-login" ? <McpLogin query={route.query} /> : null}

        {route.name === "mcp-consent" ? <McpConsent query={route.query} /> : null}

        {route.name === "unknown" ? (
          <section className="empty">
            <p>That page does not exist.</p>
            <button type="button" onClick={() => navigate("/")}>
              Back to the gallery
            </button>
          </section>
        ) : null}
      </main>

      {uploading ? (
        <UploadDialog
          maxUploadBytes={session.limits.maxUploadBytes}
          onClose={() => setUploading(false)}
          onUploaded={(artifact) => {
            setUploading(false);
            navigate(artifactPath(artifact.id));
          }}
        />
      ) : null}
    </>
  );
}
