import { describe, expect, test } from "bun:test";
import { type Env, parseEnv } from "../env.ts";
import { parseAuthConfig, publicProviders } from "./config.ts";

const google = { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" };
const allowed = { AUTH_ALLOWED_EMAIL_DOMAINS: "acme.example" };

function env(overrides: Partial<Record<string, string>> = {}): Env {
  return parseEnv({ ...overrides });
}

describe("parseAuthConfig", () => {
  test("enables the providers the deployment listed", () => {
    const config = parseAuthConfig(env(), { AUTH_PROVIDERS: "google", ...google, ...allowed });
    expect(config.providers.map((provider) => provider.id)).toEqual(["google"]);
  });

  test("refuses to start when an enabled provider has no credentials", () => {
    expect(() => parseAuthConfig(env(), { AUTH_PROVIDERS: "google", ...allowed })).toThrow(
      /GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET/,
    );
  });

  test("refuses to start on a provider id this build does not have", () => {
    expect(() => parseAuthConfig(env(), { AUTH_PROVIDERS: "okta", ...allowed })).toThrow(/okta/);
  });

  test("refuses to start with no admission policy, which would admit nobody", () => {
    expect(() => parseAuthConfig(env(), { AUTH_PROVIDERS: "google", ...google })).toThrow(
      /AUTH_ALLOWED_EMAIL_DOMAINS/,
    );
  });

  test("requires open admission to be explicit", () => {
    const config = parseAuthConfig(env(), {
      AUTH_PROVIDERS: "google",
      ...google,
      AUTH_ALLOW_ALL_AUTHENTICATED: "true",
    });
    expect(config.admission).toEqual({ kind: "all-authenticated" });
  });

  test("rejects a contradictory policy instead of silently preferring one", () => {
    expect(() =>
      parseAuthConfig(env(), {
        AUTH_PROVIDERS: "google",
        ...google,
        ...allowed,
        AUTH_ALLOW_ALL_AUTHENTICATED: "true",
      }),
    ).toThrow(/both set/);
  });

  test("rejects a value that is neither true nor false, which could read as off", () => {
    expect(() =>
      parseAuthConfig(env(), { ...allowed, AUTH_ALLOW_ALL_AUTHENTICATED: "yes" }),
    ).toThrow(/AUTH_ALLOW_ALL_AUTHENTICATED/);
  });

  test("reports every problem at once, so one restart shows the whole picture", () => {
    let message = "";
    try {
      parseAuthConfig(env(), { AUTH_PROVIDERS: "google" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("GOOGLE_CLIENT_ID");
    expect(message).toContain("AUTH_ALLOWED_EMAIL_DOMAINS");
  });

  test("refuses to start a production deployment with no provider to sign in with", () => {
    const production = env({
      NODE_ENV: "production",
      SESSION_SECRET: "s".repeat(32),
      APP_URL: "https://share.acme.example",
      CONTENT_URL: "https://content.share.acme.example",
    });
    expect(() => parseAuthConfig(production, allowed)).toThrow(/AUTH_PROVIDERS/);
  });

  test("uses secure cookies only in production, so development over http still works", () => {
    expect(parseAuthConfig(env(), allowed).useSecureCookies).toBe(false);
    const production = env({
      NODE_ENV: "production",
      SESSION_SECRET: "s".repeat(32),
      APP_URL: "https://share.acme.example",
      CONTENT_URL: "https://content.share.acme.example",
    });
    const config = parseAuthConfig(production, { AUTH_PROVIDERS: "google", ...google, ...allowed });
    expect(config.useSecureCookies).toBe(true);
    expect(config.secret).toBe("s".repeat(32));
  });
});

describe("publicProviders", () => {
  test("exposes the id and label only, never the client credentials", () => {
    const config = parseAuthConfig(env(), { AUTH_PROVIDERS: "google", ...google, ...allowed });
    expect(publicProviders(config)).toEqual([{ id: "google", label: "Google" }]);
    expect(JSON.stringify(publicProviders(config))).not.toContain("secret");
  });
});
