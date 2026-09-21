import type { Auth } from "../auth/auth.ts";
import { type AdmissionPolicy, admits } from "../auth/policy.ts";
import type { ResolvePrincipal } from "./routes.ts";

/**
 * Maps an access token to an application user. The token's subject is the only
 * identity that counts, and the admission policy runs again here, so revoking
 * a domain also stops the tokens that were issued under it.
 */
export function createPrincipalResolver(options: {
  auth: Auth;
  admission: AdmissionPolicy;
}): ResolvePrincipal {
  return async (claims) => {
    const subject = typeof claims.sub === "string" ? claims.sub : null;
    if (!subject) return null;

    const context = await options.auth.$context;
    const user = await context.internalAdapter.findUserById(subject);
    if (!user) return null;

    return admits(options.admission, user).admitted ? { userId: user.id } : null;
  };
}
