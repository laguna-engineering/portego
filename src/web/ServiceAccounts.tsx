import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  approveEnrollment,
  disableServiceAccount,
  type Enrollment,
  fetchEnrollment,
  fetchServiceAccounts,
  fetchTeams,
  type ServiceAccount,
  type Team,
} from "./api.ts";
import { useNow } from "./clock.ts";
import { RelativeTime } from "./RelativeTime.tsx";

function message(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

/** The code as the agent's terminal prints it. */
function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function status(account: ServiceAccount, now: Date): string {
  if (account.disabledAt) return "Disabled";
  if (Date.parse(account.expiresAt) <= now.getTime()) return "Expired";
  return "Active";
}

export function NotAdmin({ what = "service accounts" }: { what?: string }) {
  return (
    <section className="empty">
      <p>Only an administrator can manage {what}.</p>
    </section>
  );
}

/** `teams`: the deployment has teams, so an account is a member or a guest. */
export function ServiceAccountList({ teams = false }: { teams?: boolean }) {
  const now = useNow();
  const [accounts, setAccounts] = useState<ServiceAccount[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setAccounts(await fetchServiceAccounts());
      setProblem(null);
    } catch (error) {
      setProblem(message(error, "Could not load the service accounts."));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const disable = async (account: ServiceAccount) => {
    if (!window.confirm(`Disable ${account.name}? Its key stops working at once.`)) return;
    setBusy(account.id);
    try {
      const updated = await disableServiceAccount(account.id);
      setAccounts((current) =>
        (current ?? []).map((entry) => (entry.id === updated.id ? updated : entry)),
      );
      setProblem(null);
    } catch (error) {
      setProblem(message(error, "Could not disable that account."));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="service-accounts">
      <h1>Service accounts</h1>
      <p className="hint">
        Agents sign in with a key that renews itself every day. An account whose key has not been
        renewed for 7 days expires, and the agent has to enroll again.
      </p>
      {problem ? (
        <p className="problem" role="alert">
          {problem}
        </p>
      ) : null}
      {accounts === null ? <p className="hint">Loading...</p> : null}
      {accounts?.length === 0 ? (
        <p className="empty">
          No service accounts yet. An agent enrolls with
          <code>portego-upload service-key enroll</code>, which prints a link to approve here.
        </p>
      ) : null}
      {accounts && accounts.length > 0 ? (
        <div className="service-account-table">
          <table>
            <thead>
              <tr>
                <th scope="col">Name</th>
                {teams ? <th scope="col">Kind</th> : null}
                <th scope="col">Status</th>
                <th scope="col">Key renewed</th>
                <th scope="col">Expires</th>
                <th scope="col">Approved by</th>
                <th scope="col" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => (
                <tr key={account.id}>
                  <td>{account.name}</td>
                  {teams ? <td>{account.guest ? "Guest" : "Member"}</td> : null}
                  <td>{status(account, now)}</td>
                  <td>
                    <RelativeTime iso={account.renewedAt} />
                  </td>
                  <td>
                    <RelativeTime iso={account.expiresAt} />
                  </td>
                  <td>{account.approvedBy.name}</td>
                  <td>
                    {account.disabledAt ? null : (
                      <button
                        type="button"
                        disabled={busy === account.id}
                        onClick={() => void disable(account)}
                      >
                        Disable
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

export type ServiceAccountApprovalProps = {
  id: string;
  /** The deployment has teams, so a new account can be a guest in some of them. */
  teams?: boolean;
  onDone: () => void;
};

/**
 * Where an agent's enrollment link lands. The admin compares the code with
 * the one the agent's terminal shows before approving, so a link sent by
 * someone else cannot be approved by mistake.
 */
export function ServiceAccountApproval({ id, teams = false, onDone }: ServiceAccountApprovalProps) {
  const now = useNow();
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [accounts, setAccounts] = useState<ServiceAccount[]>([]);
  const [teamList, setTeamList] = useState<Team[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [target, setTarget] = useState<"new" | string>("new");
  const [guest, setGuest] = useState(false);
  const [guestTeams, setGuestTeams] = useState<string[]>([]);
  const [approved, setApproved] = useState<ServiceAccount | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetchEnrollment(id),
      fetchServiceAccounts(),
      teams ? fetchTeams().then((overview) => overview.teams) : Promise.resolve([]),
    ])
      .then(([loaded, existing, loadedTeams]) => {
        if (cancelled) return;
        setEnrollment(loaded);
        setAccounts(existing);
        setTeamList(loadedTeams);
      })
      .catch((error) => {
        if (!cancelled) setProblem(message(error, "Could not load this request."));
      });
    return () => {
      cancelled = true;
    };
  }, [id, teams]);

  const approve = async () => {
    setBusy(true);
    try {
      const decision =
        target !== "new"
          ? { accountId: target }
          : guest
            ? { guest: true as const, teamIds: guestTeams }
            : {};
      setApproved(await approveEnrollment(id, decision));
      setProblem(null);
    } catch (error) {
      setProblem(message(error, "Could not approve this request."));
    } finally {
      setBusy(false);
    }
  };

  if (approved) {
    return (
      <section className="signin">
        <h1>Approved</h1>
        <p>
          <strong>{approved.name}</strong> can sign in now. The agent picks up the approval within a
          few seconds.
        </p>
        <button type="button" onClick={onDone}>
          See all service accounts
        </button>
      </section>
    );
  }

  if (!enrollment) {
    return (
      <section className="signin">
        <h1>Approve an agent</h1>
        {problem ? <p role="alert">{problem}</p> : <p className="hint">Loading...</p>}
      </section>
    );
  }

  return (
    <section className="signin service-account-approval">
      <h1>Approve {enrollment.name}</h1>
      <p>
        An agent asked to sign in as a service account. Approve only if the terminal that started
        this shows the same code.
      </p>
      <dl className="enrollment-facts">
        <dt>Code</dt>
        <dd className="user-code">{formatCode(enrollment.userCode)}</dd>
        <dt>Requested</dt>
        <dd>
          <RelativeTime iso={enrollment.createdAt} />
        </dd>
      </dl>

      <fieldset>
        <legend>Account</legend>
        <label className="toggle">
          <input
            type="radio"
            name="target"
            checked={target === "new"}
            onChange={() => setTarget("new")}
          />
          A new account
        </label>
        {accounts.map((account) => (
          <label key={account.id} className="toggle">
            <input
              type="radio"
              name="target"
              checked={target === account.id}
              onChange={() => setTarget(account.id)}
            />
            Give {account.name} this key ({status(account, now).toLowerCase()})
          </label>
        ))}
      </fieldset>

      {teams && target === "new" ? (
        <fieldset>
          <legend>Kind</legend>
          <label className="toggle">
            <input type="radio" name="kind" checked={!guest} onChange={() => setGuest(false)} />
            Member: reads every folder without a team, and its teams' folders
          </label>
          <label className="toggle">
            <input type="radio" name="kind" checked={guest} onChange={() => setGuest(true)} />
            Guest: reads only its teams' folders
          </label>
        </fieldset>
      ) : null}

      {teams && target === "new" && guest ? (
        <fieldset>
          <legend>Teams</legend>
          {teamList.length === 0 ? <p className="hint">Create a team first.</p> : null}
          {teamList.map((team) => (
            <label key={team.id} className="toggle">
              <input
                type="checkbox"
                checked={guestTeams.includes(team.id)}
                onChange={(event) =>
                  setGuestTeams((current) =>
                    event.target.checked
                      ? [...current, team.id]
                      : current.filter((teamId) => teamId !== team.id),
                  )
                }
              />
              {team.name}
            </label>
          ))}
        </fieldset>
      ) : null}

      {problem ? <p role="alert">{problem}</p> : null}
      <div className="dialog-actions">
        <button
          type="button"
          className="primary"
          disabled={busy || (teams && target === "new" && guest && guestTeams.length === 0)}
          onClick={() => void approve()}
        >
          {busy ? "Working..." : "Approve"}
        </button>
      </div>
    </section>
  );
}
