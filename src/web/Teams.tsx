import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import {
  ApiError,
  createInvitation,
  createTeam,
  deleteTeam,
  fetchInvitations,
  fetchTeams,
  type Invitation,
  renameTeam,
  revokeInvitation,
  setTeamFolder,
  setTeamMember,
  type Team,
  type TeamOverview,
} from "./api.ts";
import { useNow } from "./clock.ts";
import { folderPath } from "./folders.ts";
import { RelativeTime } from "./RelativeTime.tsx";

function message(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

function Problem({ text }: { text: string | null }) {
  return text ? (
    <p className="problem" role="alert">
      {text}
    </p>
  ) : null;
}

/** Teams, their members, and the folders they restrict. For admins only. */
export function TeamList() {
  const [overview, setOverview] = useState<TeamOverview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const nameId = useId();

  const load = useCallback(async () => {
    try {
      setOverview(await fetchTeams());
      setProblem(null);
    } catch (error) {
      setProblem(message(error, "Could not load the teams."));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Each change answers with one team. The rest of the page is read again,
  // because a change can also move public links or add a member's name.
  const change = async (action: () => Promise<unknown>, fallback: string) => {
    setBusy(true);
    try {
      await action();
      await load();
    } catch (error) {
      setProblem(message(error, fallback));
    } finally {
      setBusy(false);
    }
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() === "") return;
    await change(async () => {
      await createTeam(name.trim());
      setName("");
    }, "Could not create that team.");
  };

  return (
    <section className="service-accounts teams">
      <h1>Teams</h1>
      <p className="hint">
        A folder with teams is open only to their members, and so is everything inside it. Members
        of the company read every folder without a team. A guest reads only their teams' folders.
        Administrators are no exception: to read a team's folder, add yourself to the team.
      </p>
      <Problem text={problem} />

      <form className="team-create" onSubmit={(event) => void create(event)}>
        <label htmlFor={nameId}>New team</label>
        <div className="team-row">
          <input
            id={nameId}
            value={name}
            maxLength={100}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
          <button type="submit" disabled={busy || name.trim() === ""}>
            Create team
          </button>
        </div>
      </form>

      {overview === null ? <p className="hint">Loading...</p> : null}
      {overview?.teams.length === 0 ? <p className="empty">No teams yet.</p> : null}
      {overview?.teams.map((team) => (
        <TeamCard key={team.id} team={team} overview={overview} busy={busy} change={change} />
      ))}
    </section>
  );
}

function TeamCard({
  team,
  overview,
  busy,
  change,
}: {
  team: Team;
  overview: TeamOverview;
  busy: boolean;
  change: (action: () => Promise<unknown>, fallback: string) => Promise<void>;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [person, setPerson] = useState("");
  const [folder, setFolder] = useState("");

  const members = new Set(team.members.map((member) => member.id));
  const candidates = overview.people.filter((account) => !members.has(account.id));
  const folders = overview.folders
    .filter((entry) => !team.folderIds.includes(entry.id))
    .map((entry) => ({ id: entry.id, path: folderPath(entry, overview.folders) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const restricted = team.folderIds.map((id) => {
    const entry = overview.folders.find((candidate) => candidate.id === id);
    return { id, path: entry ? folderPath(entry, overview.folders) : id };
  });
  const teamsOn = (id: string) => overview.teams.filter((other) => other.folderIds.includes(id));

  const restrict = async () => {
    if (folder === "") return;
    // The first team narrows who can read the folder, so the links under it go.
    if (
      teamsOn(folder).length === 0 &&
      !window.confirm(
        "Only this team will read the folder and everything in it. Public links to the artifacts in it stop working. Continue?",
      )
    ) {
      return;
    }
    await change(() => setTeamFolder(team.id, folder, true), "Could not restrict that folder.");
    setFolder("");
  };

  const remove = async () => {
    if (!window.confirm(`Delete the team ${team.name}?`)) return;
    await change(() => deleteTeam(team.id), "Could not delete that team.");
  };

  return (
    <article className="team-card" aria-label={team.name}>
      {renaming === null ? (
        <div className="team-row">
          <h2>{team.name}</h2>
          <button type="button" disabled={busy} onClick={() => setRenaming(team.name)}>
            Rename
          </button>
          <button type="button" disabled={busy} onClick={() => void remove()}>
            Delete
          </button>
        </div>
      ) : (
        <form
          className="team-row"
          onSubmit={(event) => {
            event.preventDefault();
            void change(async () => {
              await renameTeam(team.id, renaming);
              setRenaming(null);
            }, "Could not rename that team.");
          }}
        >
          <input
            aria-label="Team name"
            value={renaming}
            maxLength={100}
            onChange={(event) => setRenaming(event.target.value)}
          />
          <button type="submit" disabled={busy || renaming.trim() === ""}>
            Save
          </button>
          <button type="button" onClick={() => setRenaming(null)}>
            Cancel
          </button>
        </form>
      )}

      <h3>Members</h3>
      {team.members.length === 0 ? <p className="hint">Nobody yet.</p> : null}
      <ul className="team-list">
        {team.members.map((member) => (
          <li key={member.id} className="team-row">
            <span className="team-entry">
              {member.name} <span className="hint">{member.email}</span>
              {member.guest ? <span className="team-badge">Guest</span> : null}
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void change(
                  () => setTeamMember(team.id, member.id, false),
                  "Could not remove that member.",
                )
              }
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <div className="team-row">
        <select
          aria-label={`Add a member to ${team.name}`}
          value={person}
          onChange={(event) => setPerson(event.target.value)}
        >
          <option value="">Add a member...</option>
          {candidates.map((account) => (
            <option key={account.id} value={account.id}>
              {account.name} ({account.serviceAccount ? "service account" : account.email})
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={busy || person === ""}
          onClick={() =>
            void change(async () => {
              await setTeamMember(team.id, person, true);
              setPerson("");
            }, "Could not add that member.")
          }
        >
          Add
        </button>
      </div>

      <h3>Folders</h3>
      {restricted.length === 0 ? <p className="hint">This team restricts no folder.</p> : null}
      <ul className="team-list">
        {restricted.map((entry) => (
          <li key={entry.id} className="team-row">
            <span className="team-entry">{entry.path}</span>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void change(
                  () => setTeamFolder(team.id, entry.id, false),
                  "Could not remove that restriction.",
                )
              }
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <div className="team-row">
        <select
          aria-label={`Restrict a folder to ${team.name}`}
          value={folder}
          onChange={(event) => setFolder(event.target.value)}
        >
          <option value="">Restrict a folder...</option>
          {folders.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.path}
            </option>
          ))}
        </select>
        <button type="button" disabled={busy || folder === ""} onClick={() => void restrict()}>
          Restrict
        </button>
      </div>
    </article>
  );
}

/** Invitations for guests from domains the deployment does not admit. For admins only. */
export function InvitationList() {
  const now = useNow();
  const [invitations, setInvitations] = useState<Invitation[] | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const emailId = useId();

  const load = useCallback(async () => {
    try {
      const [loaded, overview] = await Promise.all([fetchInvitations(), fetchTeams()]);
      setInvitations(loaded);
      setTeams(overview.teams);
      setProblem(null);
    } catch (error) {
      setProblem(message(error, "Could not load the invitations."));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const invite = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await createInvitation(email.trim(), chosen);
      setEmail("");
      setChosen([]);
      await load();
    } catch (error) {
      setProblem(message(error, "Could not send that invitation."));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (invitation: Invitation) => {
    setBusy(true);
    try {
      await revokeInvitation(invitation.id);
      await load();
    } catch (error) {
      setProblem(message(error, "Could not revoke that invitation."));
    } finally {
      setBusy(false);
    }
  };

  const teamNames = (ids: string[]) =>
    ids.map((id) => teams.find((team) => team.id === id)?.name ?? "a deleted team").join(", ");
  const state = (invitation: Invitation) => {
    if (invitation.acceptedAt) return "Accepted";
    if (Date.parse(invitation.expiresAt) <= now.getTime()) return "Expired";
    return "Open";
  };

  return (
    <section className="service-accounts teams">
      <h1>Invitations</h1>
      <p className="hint">
        An invitation lets one address from any domain sign in as a guest, who reads only the
        folders of the chosen teams. An address in an allowed domain stays a member and joins the
        teams. The invitation works for 7 days: ask the person to sign in with that address.
      </p>
      <Problem text={problem} />

      <form className="team-create" onSubmit={(event) => void invite(event)}>
        <label htmlFor={emailId}>Email address</label>
        <input
          id={emailId}
          type="email"
          value={email}
          disabled={busy}
          onChange={(event) => setEmail(event.target.value)}
        />
        <fieldset>
          <legend>Teams</legend>
          {teams.length === 0 ? <p className="hint">Create a team first.</p> : null}
          {teams.map((team) => (
            <label key={team.id} className="toggle">
              <input
                type="checkbox"
                checked={chosen.includes(team.id)}
                onChange={(event) =>
                  setChosen((current) =>
                    event.target.checked
                      ? [...current, team.id]
                      : current.filter((id) => id !== team.id),
                  )
                }
              />
              {team.name}
            </label>
          ))}
        </fieldset>
        <div className="dialog-actions">
          <button
            type="submit"
            className="primary"
            disabled={busy || email.trim() === "" || chosen.length === 0}
          >
            Invite
          </button>
        </div>
      </form>

      {invitations === null ? <p className="hint">Loading...</p> : null}
      {invitations?.length === 0 ? <p className="empty">No invitations yet.</p> : null}
      {invitations && invitations.length > 0 ? (
        <div className="service-account-table">
          <table>
            <thead>
              <tr>
                <th scope="col">Address</th>
                <th scope="col">Teams</th>
                <th scope="col">State</th>
                <th scope="col">Expires</th>
                <th scope="col">Invited by</th>
                <th scope="col" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {invitations.map((invitation) => (
                <tr key={invitation.id}>
                  <td>{invitation.email}</td>
                  <td>{teamNames(invitation.teamIds)}</td>
                  <td>{state(invitation)}</td>
                  <td>
                    <RelativeTime iso={invitation.expiresAt} />
                  </td>
                  <td>{invitation.invitedBy.name}</td>
                  <td>
                    {invitation.acceptedAt ? null : (
                      <button type="button" disabled={busy} onClick={() => void revoke(invitation)}>
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
