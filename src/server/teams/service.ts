import type { Database } from "bun:sqlite";
import { type AccessService, createAccessService, OPEN_ACCESS } from "../access/service.ts";
import { ServiceError } from "../artifacts/errors.ts";
import { emailDomain, parseAllowedDomains, SERVICE_ACCOUNT_EMAIL_DOMAIN } from "../auth/policy.ts";
import type { EventBus } from "../events/bus.ts";
import {
  createTeamStore,
  type FolderEntry,
  type Invitation,
  type Person,
  type Team,
  type TeamStore,
} from "../storage/teams.ts";

export const TEAM_NAME_MAX_LENGTH = 100;
export const INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/** Exists only with TEAMS=true. Every method is for admins; the routes check that. */
export type TeamService = {
  overview: () => { teams: Team[]; people: Person[]; folders: FolderEntry[] };
  createTeam: (input: { name: unknown }, adminId: string) => Team;
  renameTeam: (id: string, input: { name: unknown }) => Team;
  /** Refused while the team restricts a folder. */
  deleteTeam: (id: string) => void;
  addMember: (teamId: string, userId: string, adminId: string) => Team;
  removeMember: (teamId: string, userId: string) => Team;
  /** The first team on a folder revokes the public links under it. */
  addFolder: (teamId: string, folderId: string, adminId: string) => Team;
  removeFolder: (teamId: string, folderId: string) => Team;
  invitations: () => Invitation[];
  invite: (input: { email: unknown; teamIds: unknown }, adminId: string) => Invitation;
  revokeInvitation: (id: string) => void;
  /** For admission: an existing guest, or an address with an open invitation. */
  invited: (identity: { id?: string | null; email?: string | null }) => boolean;
  /** Called on every new session, after admission. */
  acceptInvitations: (user: { id: string; email: string }, member: boolean) => void;
  isGuest: (userId: string) => boolean;
};

function teamName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (name === "" || name.length > TEAM_NAME_MAX_LENGTH) {
    throw new ServiceError(
      "INVALID_INPUT",
      `A team name is 1 to ${TEAM_NAME_MAX_LENGTH} characters.`,
    );
  }
  return name;
}

function invitationEmail(value: unknown): string {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  const domain = emailDomain(email);
  if (!domain || !parseAllowedDomains(domain).ok) {
    throw new ServiceError("INVALID_INPUT", "Send the email address to invite.");
  }
  if (domain === SERVICE_ACCOUNT_EMAIL_DOMAIN) {
    throw new ServiceError("INVALID_INPUT", "That address belongs to a service account.");
  }
  return email;
}

function duplicate(cause: unknown): never {
  if (cause instanceof Error && /unique/i.test(cause.message)) {
    throw new ServiceError("INVALID_INPUT", "A team with that name already exists.");
  }
  throw cause;
}

export function createTeamService(options: {
  store: TeamStore;
  events?: EventBus;
  now?: () => number;
}): TeamService {
  const { store } = options;
  const now = options.now ?? Date.now;
  const publish = options.events?.publish ?? (() => {});

  const team = (id: string): Team => {
    const found = store.teams().find((candidate) => candidate.id === id);
    if (!found) throw new ServiceError("NOT_FOUND", "No such team.");
    return found;
  };

  // A change to a team or its folders changes who reads those folders. The
  // stream checks each reader when an event is sent, so announcing the
  // folders before and after the change reaches the old readers and the new.
  const announcing = <T>(folderIds: string[], change: () => T): T => {
    for (const id of folderIds) publish({ type: "folder.changed", id });
    const result = change();
    for (const id of folderIds) publish({ type: "folder.changed", id });
    return result;
  };

  return {
    overview: () => ({ teams: store.teams(), people: store.people(), folders: store.folders() }),

    createTeam(input, adminId) {
      const name = teamName(input.name);
      try {
        return team(store.createTeam({ name, createdBy: adminId, now: now() }));
      } catch (cause) {
        return duplicate(cause);
      }
    },

    renameTeam(id, input) {
      const name = teamName(input.name);
      try {
        if (!store.renameTeam(id, name)) throw new ServiceError("NOT_FOUND", "No such team.");
      } catch (cause) {
        if (cause instanceof ServiceError) throw cause;
        duplicate(cause);
      }
      return team(id);
    },

    deleteTeam(id) {
      const result = store.deleteTeam(id);
      if (result === "missing") throw new ServiceError("NOT_FOUND", "No such team.");
      if (result === "has-folders") {
        throw new ServiceError(
          "FORBIDDEN",
          "Remove the team from its folders first, so no folder loses a restriction by accident.",
        );
      }
    },

    addMember(teamId, userId, adminId) {
      const added = announcing(team(teamId).folderIds, () =>
        store.addMember({ teamId, userId, addedBy: adminId, now: now() }),
      );
      if (!added) throw new ServiceError("NOT_FOUND", "No such account.");
      return team(teamId);
    },

    removeMember(teamId, userId) {
      announcing(team(teamId).folderIds, () => store.removeMember(teamId, userId));
      return team(teamId);
    },

    addFolder(teamId, folderId, adminId) {
      team(teamId);
      const revoked = announcing([folderId], () =>
        store.addFolder({ teamId, folderId, addedBy: adminId, now: now() }),
      );
      if (revoked === null) throw new ServiceError("NOT_FOUND", "No such folder.");
      for (const id of revoked) publish({ type: "artifact.changed", id });
      return team(teamId);
    },

    removeFolder(teamId, folderId) {
      team(teamId);
      announcing([folderId], () => store.removeFolder(teamId, folderId));
      return team(teamId);
    },

    invitations: () => store.invitations(),

    invite(input, adminId) {
      const email = invitationEmail(input.email);
      const teamIds = input.teamIds;
      if (
        !Array.isArray(teamIds) ||
        teamIds.length === 0 ||
        teamIds.some((id) => typeof id !== "string" || !store.teamExists(id))
      ) {
        throw new ServiceError("INVALID_INPUT", "Choose one or more existing teams.");
      }
      const at = now();
      return store.createInvitation({
        email,
        teamIds: [...new Set(teamIds as string[])],
        invitedBy: adminId,
        now: at,
        expiresAt: at + INVITATION_LIFETIME_MS,
      });
    },

    revokeInvitation(id) {
      if (!store.deleteInvitation(id)) {
        throw new ServiceError("NOT_FOUND", "No such open invitation.");
      }
    },

    invited: (identity) => store.invited(identity, now()),
    acceptInvitations: (user, member) => store.acceptInvitations(user, member, now()),
    isGuest: (userId) => store.isGuest(userId),
  };
}

/**
 * The access check and the admin service. With `enabled` false, every folder
 * is open to everyone, nobody is a guest, and there is no admin service.
 */
export function createTeams(
  database: Database,
  options: { enabled: boolean; events?: EventBus; now?: () => number },
): { access: AccessService; teams: TeamService | null; store: TeamStore | null } {
  if (!options.enabled) return { access: OPEN_ACCESS, teams: null, store: null };
  const store = createTeamStore(database);
  return {
    access: createAccessService(store),
    teams: createTeamService({ store, events: options.events, now: options.now }),
    store,
  };
}
