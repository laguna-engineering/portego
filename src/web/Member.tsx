import { type MouseEvent, type ReactNode, useEffect, useId, useState } from "react";
import { Avatar } from "./Avatar.tsx";
import {
  ApiError,
  fetchMemberHistory,
  fetchMemberProfile,
  type HistoryEntry,
  type HistoryKind,
  type HistoryPage,
  type MemberProfile as Profile,
} from "./api.ts";
import { type ArtifactTarget, artifactPath, memberPath } from "./router.ts";

const DATE_FORMAT = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  year: "numeric",
});
const JOINED_FORMAT = new Intl.DateTimeFormat("en", { month: "long", year: "numeric" });

const KIND_LABELS: Record<HistoryKind, string> = {
  created: "Created",
  updated: "Updated",
  commented: "Commented",
};

function entryLabel(entry: HistoryEntry): string {
  if (entry.kind === "updated") return `Updated to v${entry.versionNumber}`;
  return KIND_LABELS[entry.kind];
}

function entryTarget(entry: HistoryEntry): ArtifactTarget {
  if (entry.kind === "commented") return { commentId: entry.id };
  if (entry.kind === "updated") return { versionId: entry.id };
  return {};
}

/** Opens a path in this tab without a reload. A modified click keeps the browser's own behavior. */
function follow(event: MouseEvent<HTMLAnchorElement>, onOpen: () => void) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
  event.preventDefault();
  onOpen();
}

/**
 * A member's name, linking to their profile. It works anywhere in the app:
 * the router follows history changes, so no navigate callback is passed down.
 */
export function MemberLink({
  id,
  children,
  onFollow,
}: {
  id: string;
  children: ReactNode;
  /** Called after the link moves to the profile in this tab, e.g. to close a popover. */
  onFollow?: () => void;
}) {
  const path = memberPath(id);
  return (
    <a
      href={path}
      className="member-link"
      onClick={(event) =>
        follow(event, () => {
          window.history.pushState(null, "", path);
          window.dispatchEvent(new PopStateEvent("popstate"));
          onFollow?.();
        })
      }
    >
      {children}
    </a>
  );
}

/** What a member uploaded, updated, and commented on, newest first, a page at a time. */
export function ActivityList({
  userId,
  heading,
  onOpenArtifact,
}: {
  userId: string;
  heading: string;
  onOpenArtifact: (id: string, target: ArtifactTarget) => void;
}) {
  const headingId = useId();
  const [kind, setKind] = useState<HistoryKind | null>(null);
  const [page, setPage] = useState(0);
  const [history, setHistory] = useState<HistoryPage | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    fetchMemberHistory(userId, { kind, page })
      .then((result) => {
        if (!current) return;
        setHistory(result);
        setProblem(null);
      })
      .catch((error: unknown) => {
        if (current) {
          setProblem(error instanceof ApiError ? error.message : "Could not load the activity.");
        }
      });
    return () => {
      current = false;
    };
  }, [userId, kind, page]);

  const pages = history ? Math.max(1, Math.ceil(history.total / history.pageSize)) : 1;

  return (
    <section className="history" aria-labelledby={headingId}>
      <div className="history-bar">
        <h2 id={headingId}>{heading}</h2>
        <fieldset className="chips">
          <legend>Filter by kind</legend>
          {([null, "created", "updated", "commented"] as const).map((value) => (
            <button
              key={value ?? "all"}
              type="button"
              className={kind === value ? "chip selected" : "chip"}
              aria-pressed={kind === value}
              onClick={() => {
                setKind(value);
                setPage(0);
              }}
            >
              {value === null ? "All" : KIND_LABELS[value]}
            </button>
          ))}
        </fieldset>
      </div>
      {problem ? (
        <p className="problem" role="alert">
          {problem}
        </p>
      ) : !history ? (
        <p className="hint">Loading...</p>
      ) : history.entries.length === 0 ? (
        <p className="empty">
          {kind === null ? "No activity yet." : "No activity of this kind yet."}
        </p>
      ) : (
        <ol className="history-list">
          {history.entries.map((entry) => {
            const target = entryTarget(entry);
            return (
              <li key={entry.id}>
                <time dateTime={new Date(entry.createdAt).toISOString()}>
                  {DATE_FORMAT.format(entry.createdAt)}
                </time>
                <span className={`history-kind kind-${entry.kind}`}>{entryLabel(entry)}</span>
                <a
                  href={artifactPath(entry.artifact.id, target)}
                  className="history-title"
                  onClick={(event) =>
                    follow(event, () => onOpenArtifact(entry.artifact.id, target))
                  }
                >
                  {entry.artifact.title}
                </a>
                <span className="history-file">{entry.artifact.filename}</span>
              </li>
            );
          })}
        </ol>
      )}
      {pages > 1 ? (
        <nav className="history-pager" aria-label={`${heading} pages`}>
          <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>
            Newer
          </button>
          <span className="hint">
            Page {page + 1} of {pages}
          </span>
          <button type="button" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>
            Older
          </button>
        </nav>
      ) : null}
    </section>
  );
}

/** A member's public profile: who they are and what they did on artifacts the viewer can open. */
export function MemberProfile({
  userId,
  onOpenArtifact,
}: {
  userId: string;
  onOpenArtifact: (id: string, target: ArtifactTarget) => void;
}) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setProfile(null);
    setProblem(null);
    fetchMemberProfile(userId)
      .then((result) => {
        if (current) setProfile(result);
      })
      .catch((error: unknown) => {
        if (current) {
          setProblem(error instanceof ApiError ? error.message : "Could not load this profile.");
        }
      });
    return () => {
      current = false;
    };
  }, [userId]);

  if (problem) {
    return (
      <p className="problem" role="alert">
        {problem}
      </p>
    );
  }
  if (!profile) return <p className="hint">Loading...</p>;

  const { user, artifactCount } = profile;
  return (
    <div className="member">
      <header className="member-head">
        <Avatar email={user.name} src={user.avatar} size="4.5rem" />
        <div>
          <h1>{user.name}</h1>
          <p className="hint">
            Joined {JOINED_FORMAT.format(user.joinedAt)} · worked on {artifactCount}{" "}
            {artifactCount === 1 ? "artifact" : "artifacts"}
          </p>
        </div>
      </header>
      <ActivityList userId={user.id} heading="Activity" onOpenArtifact={onOpenArtifact} />
    </div>
  );
}
