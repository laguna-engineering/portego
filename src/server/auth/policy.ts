/**
 * Admission policy: who may use the application after a provider proves an
 * identity. Authentication and admission are separate on purpose. A provider
 * says "this is a real person with this verified email". The policy says
 * "this deployment accepts that person". Provider code never decides
 * admission, and admission code never learns which provider signed the user in.
 */

export type AdmissionPolicy =
  /** Accept only verified emails in one of these domains. */
  | { kind: "email-domains"; domains: readonly string[] }
  /** Accept every authenticated identity. Must be requested explicitly. */
  | { kind: "all-authenticated" };

export type Identity = {
  email?: string | null;
  emailVerified?: boolean | null;
};

export type AdmissionResult = { admitted: true } | { admitted: false; reason: string };

/** A hostname with at least two labels and no leading or trailing separator. */
const DOMAIN_PATTERN = /^(?!-)[a-z0-9-]+(?<!-)(\.(?!-)[a-z0-9-]+(?<!-))+$/;

export function normalizeDomain(value: string): string {
  // A trailing dot is the DNS root form of the same domain.
  return value.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * Parses `AUTH_ALLOWED_EMAIL_DOMAINS`. Returns the normalized domains, or the
 * offending entry so startup can name it.
 */
export function parseAllowedDomains(
  value: string,
): { ok: true; domains: string[] } | { ok: false; invalid: string } {
  const domains: string[] = [];
  for (const entry of value.split(",")) {
    if (entry.trim() === "") continue;
    const domain = normalizeDomain(entry);
    if (!DOMAIN_PATTERN.test(domain)) return { ok: false, invalid: entry.trim() };
    if (!domains.includes(domain)) domains.push(domain);
  }
  return { ok: true, domains };
}

/**
 * Splits an address into its domain. Returns null for anything that is not a
 * single local part followed by a single domain, so a crafted address such as
 * `a@b@acme.example` cannot be read as two different domains.
 */
export function emailDomain(email: string): string | null {
  const normalized = email.trim().toLowerCase();
  const parts = normalized.split("@");
  if (parts.length !== 2) return null;
  const [local, domain] = parts;
  if (!local || !domain) return null;
  return normalizeDomain(domain);
}

/**
 * Decides admission. Fail-closed: an absent policy, absent email, or unverified
 * email is a refusal, never a default allow.
 */
export function admits(policy: AdmissionPolicy, identity: Identity): AdmissionResult {
  const email = identity.email?.trim();
  if (!email) return { admitted: false, reason: "the identity has no email address" };
  if (identity.emailVerified !== true) {
    return { admitted: false, reason: "the provider did not report a verified email address" };
  }

  if (policy.kind === "all-authenticated") return { admitted: true };

  const domain = emailDomain(email);
  if (!domain) return { admitted: false, reason: "the email address is malformed" };
  if (!policy.domains.includes(domain)) {
    return { admitted: false, reason: "the email domain is not on the allowlist" };
  }
  return { admitted: true };
}
