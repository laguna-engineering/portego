import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ActivityFeed,
  type ActivityItem,
  fetchActivity,
  markActivityRead,
  type SubscriptionLevel,
  type SubscriptionTarget,
  setSubscription,
} from "./api.ts";
import { BellIcon } from "./Icons.tsx";
import { useLiveEvents } from "./live.ts";
import { MemberLink } from "./Member.tsx";
import { RelativeTime } from "./RelativeTime.tsx";
import type { ArtifactTarget } from "./router.ts";

/** What the actor did, to follow their name. */
function describe(item: ActivityItem): string {
  const { artifact } = item;
  switch (item.kind) {
    case "artifact.created":
      return `uploaded ${artifact.title}`;
    case "version.created":
      return `uploaded version ${item.versionNumber} of ${artifact.title}`;
    case "comment.created":
      return `${item.reply ? "replied" : "commented"} on ${artifact.title}`;
    case "status.changed":
      return item.change === "solved"
        ? `marked ${artifact.title} solved`
        : `${item.change} ${artifact.title}`;
    case "entry.changed":
      return `wrote ${item.key} on ${artifact.title}`;
  }
}

function targetOf(item: ActivityItem): ArtifactTarget | undefined {
  if (item.kind === "version.created") return { versionId: item.id };
  if (item.kind === "comment.created") return { commentId: item.id };
  return undefined;
}

/** Why the item is in the list, and the change that would take it out or bring it in. */
function why(item: ActivityItem): {
  text: string;
  action: { label: string; target: SubscriptionTarget; level: SubscriptionLevel };
} {
  const artifact: SubscriptionTarget = { kind: "artifacts", id: item.artifact.id };
  const stop = { label: "Stop watching", target: artifact, level: "none" as const };
  const watch = { label: "Watch", target: artifact, level: "all" as const };
  switch (item.reason?.kind) {
    case "uploaded":
      return { text: "You uploaded this", action: stop };
    case "commented":
      return { text: "You commented", action: stop };
    case "chosen":
      return { text: "You watch this", action: stop };
    case "folder": {
      const { folder } = item.reason as { folder: { id: string; name: string } };
      return {
        text: `Watching ${folder.name}`,
        action: {
          label: `Stop watching ${folder.name}`,
          target: { kind: "folders", id: folder.id },
          level: "none",
        },
      };
    }
    case "reply":
      return { text: "A reply to your comment", action: watch };
    default:
      return { text: "Not watching", action: watch };
  }
}

function isAfter(item: ActivityItem, readAt: string | null): boolean {
  return readAt === null || Date.parse(item.createdAt) > Date.parse(readAt);
}

/**
 * The masthead's bell. A dot marks activity the reader watches that is newer
 * than the last time they opened the list, and opening it clears the dot
 * everywhere the reader is signed in. The Everyone tab lists everything the
 * reader can see and never sets the dot. The lists follow the change stream
 * while the page is open.
 */
export function NotificationBell({
  onOpenArtifact,
}: {
  onOpenArtifact: (id: string, target?: ArtifactTarget) => void;
}) {
  const [feed, setFeed] = useState<ActivityFeed | null>(null);
  const [everyone, setEveryone] = useState<ActivityItem[] | null>(null);
  const [tab, setTab] = useState<"watching" | "everyone">("watching");
  const [open, setOpen] = useState(false);
  /** The read marker as it was when the list opened, so what was new stays marked while it is open. */
  const [openedSince, setOpenedSince] = useState<string | null>(null);
  const request = useRef(0);
  const everyoneRequest = useRef(0);
  const button = useRef<HTMLButtonElement>(null);
  const showingEveryone = open && tab === "everyone";

  const loadEveryone = useCallback(async () => {
    const attempt = ++everyoneRequest.current;
    try {
      const found = await fetchActivity("everyone");
      if (attempt === everyoneRequest.current) setEveryone(found.items);
    } catch {
      // The tab keeps what it had.
    }
  }, []);

  const load = useCallback(async () => {
    const attempt = ++request.current;
    try {
      const found = await fetchActivity();
      if (attempt === request.current) setFeed(found);
    } catch {
      // The bell keeps what it had. The next change or reconnect tries again.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (showingEveryone) void loadEveryone();
  }, [showingEveryone, loadEveryone]);

  useLiveEvents((event) => {
    if (
      event.type === "artifact.created" ||
      event.type === "artifact.changed" ||
      event.type === "comment.changed" ||
      (event.type === "entry.changed" && event.activity) ||
      event.type === "reconnected"
    ) {
      void load();
      if (showingEveryone) void loadEveryone();
    }
  });

  async function act(item: ActivityItem) {
    const { action } = why(item);
    try {
      await setSubscription(action.target, action.level);
    } catch {
      // Nothing changed, and the row still offers the same action.
      return;
    }
    await Promise.all([load(), showingEveryone ? loadEveryone() : undefined]);
  }

  const items = tab === "everyone" ? everyone : (feed?.items ?? null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const unread = feed ? feed.items.some((item) => isAfter(item, feed.readAt)) : false;

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpenedSince(feed?.readAt ?? null);
    setOpen(true);
    if (!unread) return;
    // A load already on its way may carry the old marker and bring the dot back.
    request.current += 1;
    try {
      const { readAt } = await markActivityRead();
      setFeed((current) => current && { ...current, readAt });
    } catch {
      // The dot stays, which is true: the server still counts these as unread.
    }
  }

  return (
    <div className="bell">
      <button
        ref={button}
        type="button"
        className="icon-button icon-only"
        aria-expanded={open}
        data-dot={unread || undefined}
        onClick={() => void toggle()}
      >
        <BellIcon />
        <span>{unread ? "Notifications, unread" : "Notifications"}</span>
      </button>
      {open ? (
        <>
          <button
            type="button"
            className="popover-backdrop"
            aria-hidden="true"
            tabIndex={-1}
            onClick={() => setOpen(false)}
          />
          <div className="popover activity" role="dialog" aria-label="Notifications">
            <div className="activity-heading">
              <h2>Notifications</h2>
              {(["watching", "everyone"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  className={tab === value ? "chip selected" : "chip"}
                  aria-pressed={tab === value}
                  onClick={() => setTab(value)}
                >
                  {value === "watching" ? "Watching" : "Everyone"}
                </button>
              ))}
            </div>
            {items === null || items.length === 0 ? (
              <p className="hint">
                {tab === "watching"
                  ? "Nothing you watch changed in the last 7 days."
                  : "Nothing in the last 7 days."}
              </p>
            ) : (
              <ul>
                {items.map((item) => (
                  <li
                    key={item.id}
                    className="activity-item"
                    data-unread={(item.reason && isAfter(item, openedSince)) || undefined}
                  >
                    <span>
                      <MemberLink id={item.actor.id} onFollow={() => setOpen(false)}>
                        {item.actor.name}
                      </MemberLink>{" "}
                      {describe(item)}
                    </span>
                    <button
                      type="button"
                      className="row-button"
                      aria-label={`${item.actor.name} ${describe(item)}`}
                      onClick={() => {
                        setOpen(false);
                        onOpenArtifact(item.artifact.id, targetOf(item));
                      }}
                    >
                      <RelativeTime iso={item.createdAt} />
                    </button>
                    <span className="activity-why">
                      <span>{why(item).text}</span>
                      <button type="button" className="link" onClick={() => void act(item)}>
                        {why(item).action.label}
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
