import { randomBytes, randomInt } from "node:crypto";
import {
  calculateJwkThumbprint,
  createLocalJWKSet,
  importJWK,
  type JWK,
  type JWTPayload,
  type JWTVerifyGetKey,
  jwtVerify,
} from "jose";
import { ServiceError } from "../artifacts/errors.ts";
import type { ServiceAccount, ServiceAccountStore } from "../storage/service-accounts.ts";
import type { TeamStore } from "../storage/teams.ts";

export const ENROLLMENT_LIFETIME_MS = 15 * 60 * 1000;
export const MAX_PENDING_ENROLLMENTS = 10;
/** An account whose key has not been renewed for this long is expired. */
export const ACCOUNT_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_NAME_LENGTH = 100;
/** The longest lifetime a signed request may claim, so a captured one is soon useless. */
const MAX_PROOF_LIFETIME_SECONDS = 60;

/** Consonants only, so a code never spells a word or mixes up 0 and O. */
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

export type PublicJwk = { kty: "OKP"; crv: "Ed25519"; x: string };

export type EnrollmentReview = {
  id: string;
  name: string;
  userCode: string;
  createdAt: number;
  expiresAt: number;
};

export type ServiceAccountService = {
  enroll: (input: { name: unknown; publicJwk: unknown }) => Promise<{
    id: string;
    userCode: string;
    approvalUrl: string;
    expiresAt: number;
  }>;
  /** `proof` is a JWT signed by the enrollment's key. */
  poll: (
    id: string,
    proof: string | null,
  ) => Promise<{ status: "pending" } | { status: "approved"; clientId: string }>;
  review: (id: string) => EnrollmentReview;
  /**
   * Creates an account, or gives the key to the account `accountId` names.
   * With teams on, `guest` and `teamIds` make a new account a guest in those teams.
   */
  approve: (
    id: string,
    input: { accountId?: unknown; guest?: unknown; teamIds?: unknown },
    adminId: string,
  ) => ServiceAccount;
  /**
   * `assertion` is signed by the current key and names the new key's RFC 7638
   * thumbprint in `next_jkt`.
   */
  renew: (input: {
    clientId: unknown;
    publicJwk: unknown;
    assertion: unknown;
  }) => Promise<{ renewedAt: number; expiresAt: number }>;
  disable: (userId: string) => ServiceAccount;
  list: () => ServiceAccount[];
  /** The user a client_credentials access token acts as, or null to refuse it. */
  principal: (claims: JWTPayload) => string | null;
};

/** The teams of a new guest account, or null for a member. */
function readGuest(
  input: { guest?: unknown; teamIds?: unknown },
  newAccount: boolean,
  teams: Pick<TeamStore, "teamExists"> | null,
): { teamIds: string[] } | null {
  if (input.guest === undefined || input.guest === false) return null;
  if (input.guest !== true) throw new ServiceError("INVALID_INPUT", "guest must be true or false.");
  if (!teams) throw new ServiceError("INVALID_INPUT", "This deployment has no guests.");
  if (!newAccount) {
    throw new ServiceError("INVALID_INPUT", "Only a new account can be made a guest.");
  }
  const teamIds = input.teamIds;
  if (
    !Array.isArray(teamIds) ||
    teamIds.length === 0 ||
    teamIds.some((id) => typeof id !== "string" || !teams.teamExists(id))
  ) {
    throw new ServiceError("INVALID_INPUT", "A guest needs one or more existing teams.");
  }
  return { teamIds: [...new Set(teamIds as string[])] };
}

export function parsePublicJwk(value: unknown): PublicJwk {
  const jwk = value as Record<string, unknown> | null;
  if (
    typeof jwk !== "object" ||
    jwk === null ||
    Array.isArray(jwk) ||
    jwk.kty !== "OKP" ||
    jwk.crv !== "Ed25519" ||
    typeof jwk.x !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(jwk.x) ||
    "d" in jwk
  ) {
    throw new ServiceError("INVALID_INPUT", "publicJwk must be an Ed25519 public key (OKP, no d).");
  }
  return { kty: "OKP", crv: "Ed25519", x: jwk.x };
}

function userCode(): string {
  let code = "";
  for (let index = 0; index < 8; index += 1) {
    code += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  }
  return code;
}

const invalidClient = () =>
  new ServiceError(
    "INVALID_CLIENT",
    "This key was replaced or revoked. Enroll again, and ask an admin to check the account.",
  );

export function createServiceAccountService(options: {
  store: ServiceAccountStore;
  /** The public origin. Signed requests name URLs under it as their audience. */
  baseURL: string;
  /** The MCP resource every service account's client is linked to. */
  mcpResource: string;
  now?: () => number;
  /** Checks the teams of a guest account. Null when teams are off. */
  teams?: Pick<TeamStore, "teamExists"> | null;
}): ServiceAccountService {
  const { store } = options;
  const now = options.now ?? Date.now;
  const enrollmentUrl = (id: string) =>
    `${options.baseURL}/api/service-accounts/enrollments/${encodeURIComponent(id)}`;
  const renewUrl = `${options.baseURL}/api/service-accounts/renew`;

  /** Verifies a short-lived JWT signed by one of `key`. Returns null on any failure. */
  const verify = async (
    token: unknown,
    key: JWTVerifyGetKey | CryptoKey | Uint8Array,
    expected: { issuer: string; subject?: string; audience: string },
  ): Promise<JWTPayload | null> => {
    if (typeof token !== "string") return null;
    try {
      const { payload } = await jwtVerify(token, key as Parameters<typeof jwtVerify>[1], {
        algorithms: ["EdDSA"],
        issuer: expected.issuer,
        audience: expected.audience,
        currentDate: new Date(now()),
        requiredClaims: ["exp"],
        ...(expected.subject === undefined ? {} : { subject: expected.subject }),
      });
      const remaining = (payload.exp ?? 0) - now() / 1000;
      return remaining > MAX_PROOF_LIFETIME_SECONDS ? null : payload;
    } catch {
      return null;
    }
  };

  const pendingEnrollment = (id: string) => {
    const enrollment = store.enrollment(id, now());
    if (!enrollment) throw new ServiceError("NOT_FOUND", "No such enrollment, or it expired.");
    return enrollment;
  };

  return {
    async enroll(input) {
      const name = typeof input.name === "string" ? input.name.trim() : "";
      if (name === "" || name.length > MAX_NAME_LENGTH) {
        throw new ServiceError("INVALID_INPUT", `name must be 1 to ${MAX_NAME_LENGTH} characters.`);
      }
      const publicJwk = parsePublicJwk(input.publicJwk);
      const createdAt = now();
      const enrollment = {
        id: randomBytes(16).toString("hex"),
        userCode: userCode(),
        name,
        publicJwk: JSON.stringify(publicJwk),
        accountId: null,
        createdAt,
        expiresAt: createdAt + ENROLLMENT_LIFETIME_MS,
        approvedAt: null,
      };
      if (!store.addEnrollment(enrollment, { maxPending: MAX_PENDING_ENROLLMENTS })) {
        throw new ServiceError(
          "RATE_LIMITED",
          "Too many enrollments are waiting for approval. Try again later.",
        );
      }
      return {
        id: enrollment.id,
        userCode: enrollment.userCode,
        approvalUrl: `${options.baseURL}/settings/service-accounts/approve/${enrollment.id}`,
        expiresAt: enrollment.expiresAt,
      };
    },

    async poll(id, proof) {
      const enrollment = pendingEnrollment(id);
      const key = await importJWK(JSON.parse(enrollment.publicJwk) as JWK, "EdDSA");
      const verified = await verify(proof, key, { issuer: id, audience: enrollmentUrl(id) });
      if (!verified) {
        throw new ServiceError("UNAUTHENTICATED", "Sign the request with the enrollment's key.");
      }
      if (enrollment.approvedAt === null || enrollment.accountId === null) {
        return { status: "pending" };
      }
      const account = store.byUserId(enrollment.accountId);
      if (!account) return { status: "pending" };
      return { status: "approved", clientId: account.clientId };
    },

    review(id) {
      const enrollment = pendingEnrollment(id);
      if (enrollment.approvedAt !== null) {
        throw new ServiceError("NOT_FOUND", "This enrollment was already approved.");
      }
      return {
        id: enrollment.id,
        name: enrollment.name,
        userCode: enrollment.userCode,
        createdAt: enrollment.createdAt,
        expiresAt: enrollment.expiresAt,
      };
    },

    approve(id, input, adminId) {
      const accountId = input.accountId ?? null;
      if (accountId !== null && typeof accountId !== "string") {
        throw new ServiceError(
          "INVALID_INPUT",
          "Send accountId to give the key to an existing account, or nothing for a new one.",
        );
      }
      const guest = readGuest(input, accountId === null, options.teams ?? null);
      const at = now();
      const approved = store.approve({
        enrollmentId: id,
        approvedBy: adminId,
        now: at,
        expiresAt: at + ACCOUNT_LIFETIME_MS,
        resource: options.mcpResource,
        accountId,
        ...(guest && { guest }),
      });
      if (!approved) {
        throw new ServiceError(
          "NOT_FOUND",
          "No such enrollment or account, or the enrollment expired or was already approved.",
        );
      }
      return approved;
    },

    async renew(input) {
      if (typeof input.clientId !== "string" || input.clientId === "") {
        throw new ServiceError("INVALID_INPUT", "clientId is required.");
      }
      const clientId = input.clientId;
      const publicJwk = parsePublicJwk(input.publicJwk);

      const account = store.byClientId(clientId);
      const verifiedJwks = store.clientJwks(clientId);
      if (!account || !verifiedJwks || account.disabledAt !== null || account.expiresAt <= now()) {
        throw invalidClient();
      }
      const keys = JSON.parse(verifiedJwks) as { keys: JWK[] };
      const payload = await verify(input.assertion, createLocalJWKSet(keys), {
        issuer: clientId,
        subject: clientId,
        audience: renewUrl,
      });
      if (!payload) throw invalidClient();
      // The signature covers the new key's thumbprint, so a captured assertion
      // can install no other key. That is why replays need no jti record.
      const nextThumbprint = await calculateJwkThumbprint(publicJwk);
      if (payload.next_jkt !== nextThumbprint) {
        throw new ServiceError(
          "INVALID_INPUT",
          "The assertion's next_jkt must be the RFC 7638 thumbprint of publicJwk.",
        );
      }
      const current = await Promise.all(keys.keys.map((key) => calculateJwkThumbprint(key)));
      if (current.includes(nextThumbprint)) {
        throw new ServiceError("INVALID_INPUT", "Renewal needs a new key.");
      }

      const at = now();
      const renewed = store.renew({
        clientId,
        verifiedJwks,
        jwks: JSON.stringify({ keys: [publicJwk] }),
        now: at,
        expiresAt: at + ACCOUNT_LIFETIME_MS,
      });
      // Another renewal replaced the key after this one was verified.
      if (!renewed) throw invalidClient();
      return { renewedAt: renewed.renewedAt, expiresAt: renewed.expiresAt };
    },

    disable(userId) {
      const account = store.disable(userId, now());
      if (!account) throw new ServiceError("NOT_FOUND", "No such service account.");
      return account;
    },

    list: () => store.list(),

    principal(claims) {
      if (typeof claims.sub !== "string") return null;
      const account = store.byClientId(claims.sub);
      if (!account || account.disabledAt !== null || account.expiresAt <= now()) return null;
      // A token minted before the key changed may have come from the replaced
      // key. `iat` has whole seconds, so a token from the second of the
      // renewal itself still passes.
      if (typeof claims.iat !== "number" || claims.iat < Math.floor(account.renewedAt / 1000)) {
        return null;
      }
      return account.userId;
    },
  };
}
