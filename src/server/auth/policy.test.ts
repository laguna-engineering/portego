import { describe, expect, test } from "bun:test";
import { type AdmissionPolicy, admits, emailDomain, parseAllowedDomains } from "./policy.ts";

const allowed: AdmissionPolicy = { kind: "email-domains", domains: ["acme.example"] };

describe("admits", () => {
  const verified = { email: "person@acme.example", emailVerified: true };

  test("admits a verified address in an allowed domain", () => {
    expect(admits(allowed, verified).admitted).toBe(true);
  });

  test("refuses an address the provider did not verify, which anyone could claim", () => {
    expect(admits(allowed, { ...verified, emailVerified: false }).admitted).toBe(false);
  });

  test("refuses an identity with no email, so a provider that omits it cannot pass", () => {
    expect(admits(allowed, { email: null, emailVerified: true }).admitted).toBe(false);
  });

  test("refuses a domain that merely ends with an allowed domain", () => {
    expect(admits(allowed, { ...verified, email: "a@evil-acme.example" }).admitted).toBe(false);
    expect(admits(allowed, { ...verified, email: "a@acme.example.evil" }).admitted).toBe(false);
  });

  test("refuses a subdomain of an allowed domain, which is a different mail domain", () => {
    expect(admits(allowed, { ...verified, email: "a@mail.acme.example" }).admitted).toBe(false);
  });

  test("ignores case and surrounding space, because providers do not normalize", () => {
    expect(admits(allowed, { email: " Person@Acme.Example ", emailVerified: true }).admitted).toBe(
      true,
    );
  });

  test("treats a trailing dot as the same domain, since DNS does", () => {
    expect(admits(allowed, { ...verified, email: "a@acme.example." }).admitted).toBe(true);
  });

  test("refuses an address with two @ signs rather than guessing which domain counts", () => {
    expect(admits(allowed, { ...verified, email: "a@evil.test@acme.example" }).admitted).toBe(
      false,
    );
  });

  test("refuses everyone when the allowlist is empty, instead of admitting everyone", () => {
    expect(admits({ kind: "email-domains", domains: [] }, verified).admitted).toBe(false);
  });

  test("admits any verified identity under open admission", () => {
    const open: AdmissionPolicy = { kind: "all-authenticated" };
    expect(admits(open, { email: "someone@example.com", emailVerified: true }).admitted).toBe(true);
  });

  test("still requires a verified email under open admission", () => {
    const open: AdmissionPolicy = { kind: "all-authenticated" };
    expect(admits(open, { email: "someone@example.com", emailVerified: false }).admitted).toBe(
      false,
    );
  });
});

describe("parseAllowedDomains", () => {
  test("normalizes case and space so configuration does not have to be exact", () => {
    expect(parseAllowedDomains(" Acme.Example , example.com ")).toEqual({
      ok: true,
      domains: ["acme.example", "example.com"],
    });
  });

  test("reports the offending entry so startup can name it", () => {
    expect(parseAllowedDomains("acme.example, not a domain")).toEqual({
      ok: false,
      invalid: "not a domain",
    });
  });

  test("rejects an entry that carries a local part, a common configuration slip", () => {
    expect(parseAllowedDomains("person@acme.example").ok).toBe(false);
  });

  test("rejects a bare hostname with no dot, which would match nothing useful", () => {
    expect(parseAllowedDomains("localhost").ok).toBe(false);
  });

  test("reads an empty value as an empty allowlist, not as an error", () => {
    expect(parseAllowedDomains("")).toEqual({ ok: true, domains: [] });
  });
});

describe("emailDomain", () => {
  test("returns the domain of a normal address", () => {
    expect(emailDomain("Person@Acme.Example")).toBe("acme.example");
  });

  test("returns null for an address with no domain", () => {
    expect(emailDomain("person")).toBeNull();
    expect(emailDomain("person@")).toBeNull();
  });
});
