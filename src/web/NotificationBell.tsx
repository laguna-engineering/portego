import { useCallback, useEffect, useRef, useState } from "react";
import { type ActivityFeed, type ActivityItem, fetchActivity, markActivityRead } from "./api.ts";
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
  }
}

function targetOf(item: ActivityItem): ArtifactTarget | undefined {
  if (item.kind === "version.created") return { versionId: item.id };
  if (item.kind === "comment.created") return { commentId: item.id };
  return undefined;
}

function isAfter(item: ActivityItem, readAt: string | null): boolean {
  return readAt === null || Date.parse(item.createdAt) > Date.parse(readAt);
}

/**
 * The masthead's bell. A dot marks activity newer than the last time the
 * reader opened the list, and opening it clears the dot everywhere the reader
 * is signed in. The list follows the change stream while the page is open.
 */
export function NotificationBell({
  onOpenArtifact,
}: {
  onOpenArtifact: (id: string, target?: ArtifactTarget) => void;
}) {
  const [feed, setFeed] = useState<ActivityFeed | null>(null);
  const [open, setOpen] = useState(false);
  /** The read marker as it was when the list opened, so what was new stays marked while it is open. */
  const [openedSince, setOpenedSince] = useState<string | null>(null);
  const request = useRef(0);
  const button = useRef<HTMLButtonElement>(null);

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

  useLiveEvents((event) => {
    if (
      event.type === "artifact.created" ||
      event.type === "artifact.changed" ||
      event.type === "comment.changed" ||
      event.type === "reconnected"
    ) {
      void load();
    }
  });

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
            <h2>Notifications</h2>
            {feed === null || feed.items.length === 0 ? (
              <p className="hint">Nothing in the last 7 days.</p>
            ) : (
              <ul>
                {feed.items.map((item) => (
                  <li
                    key={item.id}
                    className="activity-item"
                    data-unread={isAfter(item, openedSince) || undefined}
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
