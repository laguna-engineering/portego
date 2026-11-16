import { describe, expect, test } from "bun:test";
import { parseAuthConfig } from "../auth/config.ts";
import { parseEnv } from "../env.ts";

const allowed = { AUTH_ALLOWED_EMAIL_DOMAINS: "acme.example" };

describe("the TEAMS setting", () => {
  test("is off unless set to true", () => {
    expect(parseAuthConfig(parseEnv({}), allowed).teams).toBe(false);
    expect(parseAuthConfig(parseEnv({ TEAMS: "false" }), allowed).teams).toBe(false);
  });

  test("turns teams on with an admin", () => {
    const source = { ...allowed, TEAMS: "true", PORTEGO_ADMINS: "admin@acme.example" };
    expect(parseAuthConfig(parseEnv(source), source).teams).toBe(true);
  });

  // Nobody could manage teams or invitations, and restrictions could not change.
  test("refuses to start without an admin", () => {
    const source = { ...allowed, TEAMS: "true" };
    expect(() => parseAuthConfig(parseEnv(source), source)).toThrow(
      /TEAMS=true needs PORTEGO_ADMINS/,
    );
  });

  test("refuses a value other than true or false", () => {
    expect(() => parseEnv({ TEAMS: "yes" })).toThrow();
  });
});
