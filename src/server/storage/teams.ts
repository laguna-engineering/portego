import type { Database } from "bun:sqlite";
import type { FolderTree } from "../access/reader.ts";
import { JOIN_DISPLAY_NAME, USER_NAME } from "./names.ts";

export type TeamMember = { id: string; name: string; email: string; guest: boolean };

export type Team = {
  id: string;
  name: string;
  createdAt: number;
  members: TeamMember[];
  /** The folders this team restricts. */
  folderIds: string[];
};

export type Person = {
  id: string;
  name: string;
  email: string;
  guest: boolean;
  serviceAccount: boolean;
};

export type FolderEntry = { id: string; name: string; parentId: string | null };

export type Invitation = {
  id: string;
  email: string;
  teamIds: string[];
  invitedBy: { id: string; name: string };
  createdAt: number;
  expiresAt: number;
  acceptedAt: number | null;
};

export type TeamStore = {
  isGuest: (userId: string) => boolean;
  teamIdsOf: (userId: string) => string[];
  folderTree: () => FolderTree;
  /**
   * True for an existing guest, or for an address with an invitation that is
   * neither accepted nor expired.
   */
  invited: (identity: { id?: string | null; email?: string | null }, now: number) => boolean;
  /**
   * Accepts every open invitation for the user's address: adds the teams, and
   * makes the user a guest unless `member`.
   */
  acceptInvitations: (user: { id: string; email: string }, member: boolean, now: number) => void;

  teams: () => Team[];
  teamExists: (id: string) => boolean;
  /** Throws on a duplicate name. */
  createTeam: (input: { name: string; createdBy: string; now: number }) => string;
  /** False when the team is gone. Throws on a duplicate name. */
  renameTeam: (id: string, name: string) => boolean;
  /** Refuses while the team restricts a folder. */
  deleteTeam: (id: string) => "deleted" | "missing" | "has-folders";
  /** False when the team or the user is gone. */
  addMember: (input: { teamId: string; userId: string; addedBy: string; now: number }) => boolean;
  removeMember: (teamId: string, userId: string) => boolean;
  /**
   * Restricts a folder to the team. When it is the folder's first team, the
   * public links under it are revoked in the same transaction. Returns the
   * revoked artifacts, or null when the team or folder is gone.
   */
  addFolder: (input: {
    teamId: string;
    folderId: string;
    addedBy: string;
    now: number;
  }) => string[] | null;
  removeFolder: (teamId: string, folderId: string) => boolean;
  /** Every account, for the admin screens. */
  people: () => Person[];
  /** Every folder, unfiltered, for the admin screens. */
  folders: () => FolderEntry[];

  invitations: () => Invitation[];
  createInvitation: (input: {
    email: string;
    teamIds: string[];
    invitedBy: string;
    now: number;
    expiresAt: number;
  }) => Invitation;
  /** False when the invitation is gone or already accepted. */
  deleteInvitation: (id: string) => boolean;
};

/**
 * Revokes the public link of every artifact in the folder and below it, and
 * records each revocation the way a person's revocation is recorded, so the
 * creator sees it in the activity feed. Runs inside the caller's transaction.
 */
export function revokeLinksUnder(
  database: Database,
  folderId: string,
  actorId: string,
  now: number,
): string[] {
  const rows = database
    .query(
      `with recursive subtree(id) as (
         select ?
         union select folders.id from folders join subtree on folders.parentId = subtree.id
       )
       select id from artifacts
       where folderId in (select id from subtree) and shareToken is not null
       order by id`,
    )
    .all(folderId) as { id: string }[];
  for (const { id } of rows) {
    database
      .query("update artifacts set shareToken = null, updatedAt = ? where id = ?")
      .run(now, id);
    database
      .query(
        `insert into artifactLinkChanges (id, artifactId, change, actorId, createdAt, inApp)
         values (?, ?, 'revoked', ?, ?, 1)`,
      )
      .run(Bun.randomUUIDv7(), id, actorId, now);
  }
  return rows.map((row) => row.id);
}

type InvitationRow = {
  id: string;
  email: string;
  teamIds: string;
  invitedBy: string;
  invitedByName: string;
  createdAt: number;
  expiresAt: number;
  acceptedAt: number | null;
};

function toInvitation(row: InvitationRow): Invitation {
  return {
    id: row.id,
    email: row.email,
    teamIds: JSON.parse(row.teamIds) as string[],
    invitedBy: { id: row.invitedBy, name: row.invitedByName },
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    acceptedAt: row.acceptedAt,
  };
}

const SELECT_INVITATION = `
  select invitations.*, ${USER_NAME} as invitedByName
  from invitations join "user" on "user".id = invitations.invitedBy ${JOIN_DISPLAY_NAME}`;

export function createTeamStore(database: Database): TeamStore {
  const invitation = (id: string): Invitation | null => {
    const row = database
      .query(`${SELECT_INVITATION} where invitations.id = ?`)
      .get(id) as InvitationRow | null;
    return row ? toInvitation(row) : null;
  };

  return {
    isGuest(userId) {
      return database.query("select 1 from guests where userId = ?").get(userId) !== null;
    },

    teamIdsOf(userId) {
      const rows = database
        .query("select teamId from teamMembers where userId = ?")
        .all(userId) as {
        teamId: string;
      }[];
      return rows.map((row) => row.teamId);
    },

    folderTree() {
      const folders = database.query("select id, parentId from folders").all() as {
        id: string;
        parentId: string | null;
      }[];
      const restrictions = database.query("select folderId, teamId from folderTeams").all() as {
        folderId: string;
        teamId: string;
      }[];
      const teamsOf = new Map<string, Set<string>>();
      for (const { folderId, teamId } of restrictions) {
        const teams = teamsOf.get(folderId) ?? new Set<string>();
        teams.add(teamId);
        teamsOf.set(folderId, teams);
      }
      return {
        parentOf: new Map(folders.map((folder) => [folder.id, folder.parentId])),
        teamsOf,
      };
    },

    invited(identity, now) {
      if (identity.id && database.query("select 1 from guests where userId = ?").get(identity.id)) {
        return true;
      }
      const email = identity.email?.trim();
      if (!email) return false;
      return (
        database
          .query(
            "select 1 from invitations where email = ? and acceptedAt is null and expiresAt > ?",
          )
          .get(email, now) !== null
      );
    },

    acceptInvitations(user, member, now) {
      database.transaction(() => {
        const open = database
          .query(
            `select id, teamIds, invitedBy from invitations
             where email = ? and acceptedAt is null and expiresAt > ? order by createdAt`,
          )
          .all(user.email.trim(), now) as { id: string; teamIds: string; invitedBy: string }[];
        const [first] = open;
        if (!first) return;
        if (!member) {
          database
            .query("insert or ignore into guests (userId, invitedBy, createdAt) values (?, ?, ?)")
            .run(user.id, first.invitedBy, now);
        }
        for (const row of open) {
          // A team deleted since the invitation was sent is skipped.
          database
            .query(
              `insert or ignore into teamMembers (teamId, userId, addedBy, addedAt)
               select id, ?, ?, ? from teams where id in (select value from json_each(?))`,
            )
            .run(user.id, row.invitedBy, now, row.teamIds);
          database
            .query("update invitations set acceptedAt = ?, acceptedBy = ? where id = ?")
            .run(now, user.id, row.id);
        }
      })();
    },

    teams() {
      const teams = database
        .query("select id, name, createdAt from teams order by name collate nocase, id")
        .all() as { id: string; name: string; createdAt: number }[];
      const members = database
        .query(
          `select teamMembers.teamId, "user".id, ${USER_NAME} as name, "user".email,
             exists (select 1 from guests where guests.userId = "user".id) as guest
           from teamMembers join "user" on "user".id = teamMembers.userId ${JOIN_DISPLAY_NAME}
           order by name collate nocase, "user".id`,
        )
        .all() as (Omit<TeamMember, "guest"> & { teamId: string; guest: number })[];
      const folders = database
        .query("select teamId, folderId from folderTeams order by folderId")
        .all() as { teamId: string; folderId: string }[];
      return teams.map((team) => ({
        ...team,
        members: members
          .filter((member) => member.teamId === team.id)
          .map(({ id, name, email, guest }) => ({ id, name, email, guest: guest === 1 })),
        folderIds: folders.filter((row) => row.teamId === team.id).map((row) => row.folderId),
      }));
    },

    teamExists(id) {
      return database.query("select 1 from teams where id = ?").get(id) !== null;
    },

    createTeam({ name, createdBy, now }) {
      const id = Bun.randomUUIDv7();
      database
        .query("insert into teams (id, name, createdBy, createdAt) values (?, ?, ?, ?)")
        .run(id, name, createdBy, now);
      return id;
    },

    renameTeam(id, name) {
      return database.query("update teams set name = ? where id = ?").run(name, id).changes > 0;
    },

    deleteTeam(id) {
      return database.transaction(() => {
        if (database.query("select 1 from folderTeams where teamId = ?").get(id)) {
          return "has-folders" as const;
        }
        const deleted = database.query("delete from teams where id = ?").run(id).changes > 0;
        return deleted ? ("deleted" as const) : ("missing" as const);
      })();
    },

    addMember({ teamId, userId, addedBy, now }) {
      const result = database
        .query(
          `insert or ignore into teamMembers (teamId, userId, addedBy, addedAt)
           select teams.id, "user".id, ?, ? from teams, "user" where teams.id = ? and "user".id = ?`,
        )
        .run(addedBy, now, teamId, userId);
      if (result.changes > 0) return true;
      return (
        database
          .query("select 1 from teamMembers where teamId = ? and userId = ?")
          .get(teamId, userId) !== null
      );
    },

    removeMember(teamId, userId) {
      return (
        database
          .query("delete from teamMembers where teamId = ? and userId = ?")
          .run(teamId, userId).changes > 0
      );
    },

    addFolder({ teamId, folderId, addedBy, now }) {
      return database.transaction((): string[] | null => {
        const exists = database
          .query("select 1 from teams, folders where teams.id = ? and folders.id = ?")
          .get(teamId, folderId);
        if (!exists) return null;
        const first = database.query("select 1 from folderTeams where folderId = ?").get(folderId);
        database
          .query(
            `insert or ignore into folderTeams (folderId, teamId, addedBy, addedAt)
             values (?, ?, ?, ?)`,
          )
          .run(folderId, teamId, addedBy, now);
        // A second team widens who can read the folder, so only the first
        // narrows it.
        return first ? [] : revokeLinksUnder(database, folderId, addedBy, now);
      })();
    },

    removeFolder(teamId, folderId) {
      return (
        database
          .query("delete from folderTeams where teamId = ? and folderId = ?")
          .run(teamId, folderId).changes > 0
      );
    },

    people() {
      const rows = database
        .query(
          `select "user".id, ${USER_NAME} as name, "user".email,
             exists (select 1 from guests where guests.userId = "user".id) as guest,
             exists (select 1 from serviceAccounts where serviceAccounts.userId = "user".id)
               as serviceAccount
           from "user" ${JOIN_DISPLAY_NAME}
           order by name collate nocase, "user".id`,
        )
        .all() as (Omit<Person, "guest" | "serviceAccount"> & {
        guest: number;
        serviceAccount: number;
      })[];
      return rows.map((row) => ({
        ...row,
        guest: row.guest === 1,
        serviceAccount: row.serviceAccount === 1,
      }));
    },

    folders() {
      return database
        .query("select id, name, parentId from folders order by name collate nocase, id")
        .all() as FolderEntry[];
    },

    invitations() {
      const rows = database
        .query(`${SELECT_INVITATION} order by invitations.createdAt desc, invitations.id`)
        .all() as InvitationRow[];
      return rows.map(toInvitation);
    },

    createInvitation({ email, teamIds, invitedBy, now, expiresAt }) {
      const id = Bun.randomUUIDv7();
      database
        .query(
          `insert into invitations (id, email, teamIds, invitedBy, createdAt, expiresAt)
           values (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, email, JSON.stringify(teamIds), invitedBy, now, expiresAt);
      return invitation(id) as Invitation;
    },

    deleteInvitation(id) {
      return (
        database.query("delete from invitations where id = ? and acceptedAt is null").run(id)
          .changes > 0
      );
    },
  };
}
