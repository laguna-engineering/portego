import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { MCP_SCOPES } from "../auth/config.ts";
import { SERVICE_ACCOUNT_EMAIL_DOMAIN } from "../auth/policy.ts";
import { JOIN_DISPLAY_NAME, USER_NAME } from "./names.ts";

export type ServiceAccount = {
  userId: string;
  clientId: string;
  name: string;
  /** The admin who last approved a key for the account. */
  approvedBy: string;
  approvedByName: string;
  /** Epoch ms, like every time below. */
  createdAt: number;
  /** The last time the key changed. */
  renewedAt: number;
  expiresAt: number;
  disabledAt: number | null;
  /** Has a `guests` row. Only counts with teams on. */
  guest: boolean;
};

type AccountRow = Omit<ServiceAccount, "guest"> & { guest: number };

function toAccount(row: AccountRow | null): ServiceAccount | null {
  return row && { ...row, guest: row.guest === 1 };
}

export type Enrollment = {
  id: string;
  userCode: string;
  name: string;
  /** The public JWK the agent sent, as JSON. */
  publicJwk: string;
  /** The account the approval re-enrolled or created. */
  accountId: string | null;
  createdAt: number;
  expiresAt: number;
  approvedAt: number | null;
};

export type Approval = {
  enrollmentId: string;
  approvedBy: string;
  now: number;
  /** When the account expires unless it renews. */
  expiresAt: number;
  /** The MCP resource the OAuth client is linked to. */
  resource: string;
  /** The account that gets the key, or null for a new one. */
  accountId: string | null;
  /** Makes a new account a guest in these teams. Ignored for an existing account. */
  guest?: { teamIds: string[] };
};

export type ServiceAccountStore = {
  /** Refuses with false while `maxPending` enrollments wait for approval. */
  addEnrollment: (enrollment: Enrollment, limits: { maxPending: number }) => boolean;
  /** An enrollment that has not expired. */
  enrollment: (id: string, now: number) => Enrollment | null;
  /** Null when the enrollment is gone, already approved, or names no account. */
  approve: (approval: Approval) => ServiceAccount | null;
  /**
   * Replaces the key, but only while the stored key set is still
   * `verifiedJwks`, the one the renewal assertion was checked against.
   */
  renew: (input: {
    clientId: string;
    verifiedJwks: string;
    jwks: string;
    now: number;
    expiresAt: number;
  }) => ServiceAccount | null;
  disable: (userId: string, now: number) => ServiceAccount | null;
  byClientId: (clientId: string) => ServiceAccount | null;
  byUserId: (userId: string) => ServiceAccount | null;
  list: () => ServiceAccount[];
  /** The OAuth client's stored key set, as Better Auth reads it. */
  clientJwks: (clientId: string) => string | null;
  isServiceAccount: (userId: string) => boolean;
};

const SELECT_ACCOUNT = `
  select serviceAccounts.*, ${USER_NAME} as approvedByName,
    exists (select 1 from guests where guests.userId = serviceAccounts.userId) as guest
  from serviceAccounts join "user" on "user".id = serviceAccounts.approvedBy ${JOIN_DISPLAY_NAME}`;

function randomId(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Better Auth owns the `user`, `oauthClient`, and `oauthClientResource` tables,
 * but its admin endpoints need a session and cannot replace a key, so the rows
 * are written here. They match what its registration endpoint writes for a
 * `private_key_jwt` client; client-credentials.test.ts compares the two.
 */
export function insertOAuthClient(
  database: Database,
  input: { clientId: string; userId: string; name: string; jwks: string; resource: string },
  now: number,
): void {
  const at = new Date(now).toISOString();
  const resource = database
    .query("select 1 from oauthResource where identifier = ? and not coalesce(disabled, 0)")
    .get(input.resource);
  if (!resource) {
    throw new Error(
      `The OAuth resource ${input.resource} is missing; the server seeds it at start`,
    );
  }
  database
    .query(
      `insert into oauthClient (id, clientId, disabled, scopes, clientCredentialsScopes, userId,
         createdAt, updatedAt, name, redirectUris, tokenEndpointAuthMethod, applicationType, jwks,
         grantTypes, dpopBoundAccessTokens)
       values (?, ?, 0, ?, ?, ?, ?, ?, ?, '[]', 'private_key_jwt', 'web', ?,
         '["client_credentials"]', 0)`,
    )
    .run(
      randomId(),
      input.clientId,
      JSON.stringify(MCP_SCOPES),
      JSON.stringify(MCP_SCOPES),
      input.userId,
      at,
      at,
      input.name,
      input.jwks,
    );
  database
    .query(
      "insert into oauthClientResource (id, clientId, resourceId, createdAt) values (?, ?, ?, ?)",
    )
    .run(randomId(), input.clientId, input.resource, at);
}

export function createServiceAccountStore(database: Database): ServiceAccountStore {
  const byUserId = (userId: string) =>
    toAccount(
      database
        .query(`${SELECT_ACCOUNT} where serviceAccounts.userId = ?`)
        .get(userId) as AccountRow | null,
    );

  const byClientId = (clientId: string) =>
    toAccount(
      database
        .query(`${SELECT_ACCOUNT} where serviceAccounts.clientId = ?`)
        .get(clientId) as AccountRow | null,
    );

  const enrollment = (id: string, now: number) =>
    database
      .query("select * from serviceAccountEnrollments where id = ? and expiresAt > ?")
      .get(id, now) as Enrollment | null;

  return {
    addEnrollment(row, limits) {
      return database.transaction(() => {
        database
          .query("delete from serviceAccountEnrollments where expiresAt <= ?")
          .run(row.createdAt);
        const pending = database
          .query("select count(*) as count from serviceAccountEnrollments where approvedAt is null")
          .get() as { count: number };
        if (pending.count >= limits.maxPending) return false;
        database
          .query(
            `insert into serviceAccountEnrollments (id, userCode, name, publicJwk, createdAt, expiresAt)
             values (?, ?, ?, ?, ?, ?)`,
          )
          .run(row.id, row.userCode, row.name, row.publicJwk, row.createdAt, row.expiresAt);
        return true;
      })();
    },

    enrollment,

    approve(approval) {
      const { now } = approval;
      const userId = database.transaction((): string | null => {
        const pending = enrollment(approval.enrollmentId, now);
        if (!pending || pending.approvedAt !== null) return null;
        const jwks = JSON.stringify({ keys: [JSON.parse(pending.publicJwk)] });

        let accountId: string;
        if (approval.accountId === null) {
          accountId = randomId();
          const clientId = randomId();
          const at = new Date(now).toISOString();
          // No linked provider account and an unverified `.invalid` address:
          // sign-in has no way to reach this user.
          database
            .query(
              `insert into "user" (id, name, email, emailVerified, image, createdAt, updatedAt)
               values (?, ?, ?, 0, null, ?, ?)`,
            )
            .run(accountId, pending.name, `${clientId}@${SERVICE_ACCOUNT_EMAIL_DOMAIN}`, at, at);
          database
            .query(
              `insert into serviceAccounts
                 (userId, clientId, name, approvedBy, createdAt, renewedAt, expiresAt)
               values (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              accountId,
              clientId,
              pending.name,
              approval.approvedBy,
              now,
              now,
              approval.expiresAt,
            );
          insertOAuthClient(
            database,
            { clientId, userId: accountId, name: pending.name, jwks, resource: approval.resource },
            now,
          );
          if (approval.guest) {
            database
              .query("insert into guests (userId, invitedBy, createdAt) values (?, ?, ?)")
              .run(accountId, approval.approvedBy, now);
            for (const teamId of approval.guest.teamIds) {
              database
                .query(
                  "insert into teamMembers (teamId, userId, addedBy, addedAt) values (?, ?, ?, ?)",
                )
                .run(teamId, accountId, approval.approvedBy, now);
            }
          }
        } else {
          const existing = byUserId(approval.accountId);
          if (!existing) return null;
          accountId = existing.userId;
          database
            .query(
              `update serviceAccounts set approvedBy = ?, renewedAt = ?, expiresAt = ?, disabledAt = null
               where userId = ?`,
            )
            .run(approval.approvedBy, now, approval.expiresAt, accountId);
          database
            .query(
              "update oauthClient set jwks = ?, disabled = 0, updatedAt = ? where clientId = ?",
            )
            .run(jwks, new Date(now).toISOString(), existing.clientId);
        }

        database
          .query("update serviceAccountEnrollments set approvedAt = ?, accountId = ? where id = ?")
          .run(now, accountId, pending.id);
        return accountId;
      })();
      return userId === null ? null : byUserId(userId);
    },

    renew(input) {
      return database.transaction(() => {
        const account = byClientId(input.clientId);
        if (!account || account.disabledAt !== null || account.expiresAt <= input.now) return null;
        const updated = database
          .query("update oauthClient set jwks = ?, updatedAt = ? where clientId = ? and jwks = ?")
          .run(input.jwks, new Date(input.now).toISOString(), input.clientId, input.verifiedJwks);
        if (updated.changes !== 1) return null;
        database
          .query("update serviceAccounts set renewedAt = ?, expiresAt = ? where userId = ?")
          .run(input.now, input.expiresAt, account.userId);
        return byUserId(account.userId);
      })();
    },

    disable(userId, now) {
      return database.transaction(() => {
        const account = byUserId(userId);
        if (!account) return null;
        if (account.disabledAt === null) {
          database
            .query("update serviceAccounts set disabledAt = ? where userId = ?")
            .run(now, userId);
        }
        database
          .query("update oauthClient set disabled = 1, updatedAt = ? where clientId = ?")
          .run(new Date(now).toISOString(), account.clientId);
        return byUserId(userId);
      })();
    },

    byClientId,
    byUserId,

    list() {
      const rows = database
        .query(
          `${SELECT_ACCOUNT} order by serviceAccounts.name collate nocase, serviceAccounts.userId`,
        )
        .all() as AccountRow[];
      return rows.map((row) => toAccount(row) as ServiceAccount);
    },

    clientJwks(clientId) {
      const row = database
        .query("select jwks from oauthClient where clientId = ?")
        .get(clientId) as {
        jwks: string | null;
      } | null;
      return row?.jwks ?? null;
    },

    isServiceAccount(userId) {
      return database.query("select 1 from serviceAccounts where userId = ?").get(userId) !== null;
    },
  };
}
