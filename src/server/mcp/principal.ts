import type { Auth } from "../auth/auth.ts";
import { type AdmissionPolicy, admits } from "../auth/policy.ts";
import type { ServiceAccountService } from "../service-accounts/service.ts";
import type { TeamService } from "../teams/service.ts";
import type { ResolvePrincipal } from "./routes.ts";

/**
 * Maps an access token to an application user. The token's subject is the only
 * identity that counts, and the admission policy runs again here, so revoking
 * a domain also stops the tokens that were issued under it.
 */
export function createPrincipalResolver(options: {
  auth: Auth;
  admission: AdmissionPolicy;
  /** Null when service accounts are off. */
  serviceAccounts: ServiceAccountService | null;
  /** Admits guests. Absent or null when teams are off. */
  teams?: Pick<TeamService, "invited"> | null;
}): ResolvePrincipal {
  return async (claims) => {
    const subject = typeof claims.sub === "string" ? claims.sub : null;
    if (!subject) return null;

    // A client_credentials token names the client as its subject and carries
    // no session. A person's token always has a session, and its subject is a
    // user id. Admission for these tokens is the service account row, not the
    // email policy in policy.ts.
    if (options.serviceAccounts && claims.sid === undefined && subject === claims.azp) {
      const userId = options.serviceAccounts.principal(claims);
      return userId === null ? null : { userId };
    }

    const context = await options.auth.$context;
    const user = await context.internalAdapter.findUserById(subject);
    if (!user) return null;

    const invited = options.teams?.invited(user) ?? false;
    return admits(options.admission, user, invited).admitted ? { userId: user.id } : null;
  };
}
