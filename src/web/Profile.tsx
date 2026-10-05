import {
  type ChangeEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Avatar } from "./Avatar.tsx";
import { AvatarCropDialog } from "./AvatarCrop.tsx";
import {
  ApiError,
  type DisplayName,
  fetchProfileActivity,
  type ProfileActivity,
  removeAvatar,
  saveDisplayName,
  uploadAvatar,
} from "./api.ts";
import { useNow } from "./clock.ts";
import { ActivityList } from "./Member.tsx";
import type { ArtifactTarget } from "./router.ts";

/** The chosen file is cropped and re-encoded before upload, so it may be larger than what is saved. */
const SOURCE_MAX_BYTES = 20 * 1024 * 1024;
const MIB = 1024 * 1024;

type Day = { date: Date; count: number };

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/**
 * One cell per local day, from the Sunday on or before a year ago through
 * today, so the columns are whole weeks.
 */
function buildDays(today: Date, times: number[]): Day[] {
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const start = new Date(end);
  start.setDate(start.getDate() - 364);
  start.setDate(start.getDate() - start.getDay());

  const counts = new Map<string, number>();
  for (const time of times) {
    const key = dayKey(new Date(time));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const days: Day[] = [];
  for (let date = new Date(start); date <= end; date.setDate(date.getDate() + 1)) {
    days.push({ date: new Date(date), count: counts.get(dayKey(date)) ?? 0 });
  }
  return days;
}

function level(count: number): number {
  if (count === 0) return 0;
  if (count <= 2) return 1;
  if (count <= 4) return 2;
  if (count <= 6) return 3;
  return 4;
}

const DAY_FORMAT = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  year: "numeric",
});
const MONTH_FORMAT = new Intl.DateTimeFormat("en", { month: "short" });
const DAY_NAMES: Record<number, string> = { 1: "Mon", 3: "Wed", 5: "Fri" };

function ActivityGraph() {
  const now = useNow();
  const [activity, setActivity] = useState<ProfileActivity | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  /** The hovered cell's label, and the middle of its top edge within the panel. */
  const [hovered, setHovered] = useState<{ label: string; x: number; y: number } | null>(null);

  useEffect(() => {
    fetchProfileActivity()
      .then(setActivity)
      .catch((error: unknown) =>
        setProblem(error instanceof ApiError ? error.message : "Could not load your activity."),
      );
  }, []);

  // A string, so the grid is rebuilt when the day changes, not every minute.
  const today = now.toDateString();
  const { days, uploads, versions, comments } = useMemo(() => {
    const all = activity ? [...activity.uploads, ...activity.versions, ...activity.comments] : [];
    const days = buildDays(new Date(today), all);
    const since = (days[0] as Day).date.getTime();
    const inGraph = (times: number[] = []) => times.filter((time) => time >= since).length;
    return {
      days,
      uploads: inGraph(activity?.uploads),
      versions: inGraph(activity?.versions),
      comments: inGraph(activity?.comments),
    };
  }, [activity, today]);

  // A narrow window shows the most recent weeks first.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the grid only fills in once activity arrives.
  useEffect(() => {
    if (scroller.current) scroller.current.scrollLeft = scroller.current.scrollWidth;
  }, [activity]);

  // Shifted sideways when centring it over a cell near the edge would take
  // it past the panel, which on a phone would widen the page.
  useLayoutEffect(() => {
    const element = tip.current;
    if (!hovered || !element || !panel.current) return;
    const half = element.offsetWidth / 2;
    const x = Math.min(Math.max(hovered.x, half), panel.current.clientWidth - half);
    element.style.left = `${x}px`;
  }, [hovered]);

  const hover = (event: PointerEvent<HTMLDivElement>) => {
    const cell = (event.target as HTMLElement).closest<HTMLElement>("[data-label]");
    if (!cell || !panel.current) {
      setHovered(null);
      return;
    }
    const box = cell.getBoundingClientRect();
    const origin = panel.current.getBoundingClientRect();
    setHovered({
      label: cell.dataset.label ?? "",
      x: box.left - origin.left + box.width / 2,
      y: box.top - origin.top,
    });
  };

  const weeks: Day[][] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
  const total = uploads + versions + comments;

  return (
    <section
      className="profile-panel activity-panel"
      aria-labelledby="activity-heading"
      ref={panel}
    >
      <div className="activity-head">
        <h2 id="activity-heading">Activity</h2>
        {problem ? (
          <p className="problem" role="alert">
            {problem}
          </p>
        ) : (
          <p className="hint">
            {activity
              ? `${total} ${total === 1 ? "action" : "actions"} in the last year`
              : "Loading..."}
          </p>
        )}
      </div>
      {/* The tooltip would go stale while the grid scrolls under it. */}
      <div className="activity-scroll" ref={scroller} onScroll={() => setHovered(null)}>
        <div
          className="activity-grid"
          onPointerOver={hover}
          onPointerLeave={() => setHovered(null)}
          style={{ gridTemplateColumns: `1.9rem repeat(${weeks.length}, 0.7rem)` }}
        >
          <span />
          {weeks.map((week, i) => {
            const first = (week[0] as Day).date;
            // A label at the first week of each month, except where the last
            // columns leave it no room.
            const show = first.getDate() <= 7 && i < weeks.length - 2;
            return (
              <span key={`m${dayKey(first)}`} className="activity-month">
                {show ? MONTH_FORMAT.format(first) : ""}
              </span>
            );
          })}
          {[0, 1, 2, 3, 4, 5, 6].map((dow) => (
            <DayRow key={dow} dow={dow} weeks={weeks} />
          ))}
        </div>
      </div>
      {hovered ? (
        <div
          ref={tip}
          className="activity-tip"
          role="tooltip"
          style={{ left: hovered.x, top: hovered.y }}
        >
          {hovered.label}
        </div>
      ) : null}
      <div className="activity-foot">
        <dl className="activity-totals">
          <div>
            <dt>Artifacts uploaded</dt>
            <dd>{uploads}</dd>
          </div>
          <div>
            <dt>New versions</dt>
            <dd>{versions}</dd>
          </div>
          <div>
            <dt>Comments</dt>
            <dd>{comments}</dd>
          </div>
        </dl>
        <div className="activity-legend" aria-hidden="true">
          <span>Less</span>
          {[0, 1, 2, 3, 4].map((l) => (
            <span key={l} className={`activity-cell l${l}`} />
          ))}
          <span>More</span>
        </div>
      </div>
    </section>
  );
}

function DayRow({ dow, weeks }: { dow: number; weeks: Day[][] }) {
  return (
    <>
      <span className="activity-dow">{DAY_NAMES[dow] ?? ""}</span>
      {weeks.map((week) => {
        const day = week[dow];
        const key = dayKey((week[0] as Day).date);
        // The last week stops at today.
        if (!day) return <span key={key} />;
        const label = `${day.count === 0 ? "No" : day.count} ${day.count === 1 ? "action" : "actions"} on ${DAY_FORMAT.format(day.date)}`;
        return (
          <span key={key} className={`activity-cell l${level(day.count)}`} data-label={label} />
        );
      })}
    </>
  );
}

const DISPLAY_NAME_MAX_LENGTH = 80;

function DisplayNameForm({
  displayName,
  defaultName,
  onChange,
}: {
  displayName: string | null;
  defaultName: string;
  onChange: (names: DisplayName) => void;
}) {
  const [draft, setDraft] = useState(displayName ?? "");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const unchanged = draft.trim() === (displayName ?? "");

  const save = async (value: string) => {
    setBusy(true);
    try {
      const names = await saveDisplayName(value);
      onChange(names);
      setDraft(names.displayName ?? "");
      setProblem(null);
      setSaved(true);
    } catch (error) {
      setProblem(error instanceof ApiError ? error.message : "Could not save your name.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="profile-name"
      onSubmit={(event) => {
        event.preventDefault();
        void save(draft);
      }}
    >
      <label htmlFor="display-name">Display name</label>
      <div className="profile-name-row">
        <input
          id="display-name"
          value={draft}
          placeholder={defaultName}
          maxLength={DISPLAY_NAME_MAX_LENGTH}
          autoComplete="name"
          onChange={(event) => {
            setDraft(event.target.value);
            setSaved(false);
          }}
        />
        <button type="submit" disabled={busy || unchanged}>
          Save
        </button>
        {displayName !== null ? (
          <button type="button" disabled={busy} onClick={() => void save("")}>
            Reset
          </button>
        ) : null}
      </div>
      {problem ? (
        <p className="problem" role="alert">
          {problem}
        </p>
      ) : (
        <p className="hint profile-note" role="status">
          {saved
            ? "Saved."
            : `Shown on your profile, artifacts, and comments. Leave it empty to use ${defaultName}.`}
        </p>
      )}
    </form>
  );
}

export function Profile({
  userId,
  email,
  displayName,
  defaultName,
  avatar,
  onAvatarChange,
  onDisplayNameChange,
  onSignOut,
  onOpenArtifact,
}: {
  userId: string;
  email: string;
  displayName: string | null;
  defaultName: string;
  avatar: string | null;
  onAvatarChange: (avatar: string | null) => void;
  onDisplayNameChange: (names: DisplayName) => void;
  onSignOut: () => void;
  onOpenArtifact: (id: string, target: ArtifactTarget) => void;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cropping, setCropping] = useState<File | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const cancelCrop = useCallback(() => setCropping(null), []);

  const run = async (action: () => Promise<string | null>) => {
    setBusy(true);
    try {
      onAvatarChange(await action());
      setProblem(null);
    } catch (error) {
      setProblem(error instanceof ApiError ? error.message : "Could not save your avatar.");
    } finally {
      setBusy(false);
    }
  };

  const choose = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Cleared so choosing the same file again still fires a change.
    event.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setProblem("That file is not an image. Choose a PNG, JPEG, GIF, WebP, or AVIF file.");
      return;
    }
    if (file.size > SOURCE_MAX_BYTES) {
      setProblem(`That file is ${(file.size / MIB).toFixed(1)} MiB. The limit is 20 MiB.`);
      return;
    }
    setProblem(null);
    setCropping(file);
  };

  return (
    <div className="profile">
      <h1>Profile</h1>
      <section className="profile-panel profile-account" aria-label="Account">
        <Avatar email={email} src={avatar} size="5rem" />
        <div className="profile-identity">
          <dl>
            <dt>Email</dt>
            <dd>{email}</dd>
          </dl>
          <div className="profile-actions">
            <button type="button" disabled={busy} onClick={() => input.current?.click()}>
              {avatar ? "Change avatar" : "Upload avatar"}
            </button>
            {avatar ? (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await removeAvatar();
                    return null;
                  })
                }
              >
                Remove avatar
              </button>
            ) : null}
            <input
              ref={input}
              type="file"
              accept="image/*"
              hidden
              aria-label="Avatar image"
              onChange={choose}
            />
          </div>
          {problem ? (
            <p className="problem" role="alert">
              {problem}
            </p>
          ) : (
            <p className="hint profile-note">
              You can zoom and position the image before it is saved.
            </p>
          )}
          <DisplayNameForm
            displayName={displayName}
            defaultName={defaultName}
            onChange={onDisplayNameChange}
          />
        </div>
        <div className="profile-signout">
          <button type="button" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </section>
      <ActivityGraph />
      <ActivityList userId={userId} heading="Recent activity" onOpenArtifact={onOpenArtifact} />
      {cropping ? (
        <AvatarCropDialog
          file={cropping}
          onCancel={cancelCrop}
          onSave={async (image) => {
            await run(() => uploadAvatar(image));
            setCropping(null);
          }}
        />
      ) : null}
    </div>
  );
}
