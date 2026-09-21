import { describe, expect, test } from "bun:test";
import { parseEnv } from "./env.ts";

const SECRET = "s".repeat(32);

describe("parseEnv", () => {
  test("binds to loopback by default so only the reverse proxy can expose the service", () => {
    expect(parseEnv({}).HOST).toBe("127.0.0.1");
  });

  test("reads PORT as a number so Bun.serve does not receive a string", () => {
    expect(parseEnv({ PORT: "8080" }).PORT).toBe(8080);
  });

  test("rejects a PORT that is not a valid port number", () => {
    expect(() => parseEnv({ PORT: "not-a-port" })).toThrow(/PORT/);
    expect(() => parseEnv({ PORT: "70000" })).toThrow(/PORT/);
  });

  test("refuses to start in production without SESSION_SECRET", () => {
    expect(() => parseEnv({ NODE_ENV: "production" })).toThrow(/SESSION_SECRET/);
  });

  test("rejects a SESSION_SECRET too short to be a useful signing key", () => {
    expect(() => parseEnv({ NODE_ENV: "production", SESSION_SECRET: "short" })).toThrow(
      /SESSION_SECRET/,
    );
  });

  test("allows a missing SESSION_SECRET outside production so a clean checkout runs", () => {
    expect(parseEnv({ NODE_ENV: "development" }).SESSION_SECRET).toBeUndefined();
  });

  test("treats an empty value as absent so a copied .env.example still starts", () => {
    const env = parseEnv({ NODE_ENV: "development", HOST: "", PORT: "", SESSION_SECRET: "" });
    expect(env.HOST).toBe("127.0.0.1");
    expect(env.PORT).toBe(3000);
    expect(env.SESSION_SECRET).toBeUndefined();
  });

  test("still refuses to start in production when SESSION_SECRET is empty", () => {
    expect(() => parseEnv({ NODE_ENV: "production", SESSION_SECRET: "" })).toThrow(
      /SESSION_SECRET/,
    );
  });

  test("rejects an absolute CLIENT_DIST, which hono would resolve from the working directory", () => {
    expect(() => parseEnv({ CLIENT_DIST: "/srv/app/dist/client" })).toThrow(/CLIENT_DIST/);
  });

  test("refuses to start in production without the public origin used for OAuth callbacks", () => {
    expect(() => parseEnv({ NODE_ENV: "production", SESSION_SECRET: SECRET })).toThrow(/APP_URL/);
  });

  test("rejects an APP_URL that is not an absolute URL", () => {
    expect(() => parseEnv({ APP_URL: "share.acme.example" })).toThrow(/APP_URL/);
  });

  test("drops a trailing slash from APP_URL, which would double the slash in callback URLs", () => {
    expect(parseEnv({ APP_URL: "https://share.acme.example/" }).APP_URL).toBe(
      "https://share.acme.example",
    );
  });

  test("points at the Vite origin by default, because the browser reaches Hono through it", () => {
    expect(parseEnv({}).APP_URL).toBe("http://localhost:5173");
  });

  test("keeps SQLite and artifact files out of the repository by default", () => {
    expect(parseEnv({}).DATA_DIR).toBe("data");
  });

  test("refuses to start in production without an isolated content origin", () => {
    expect(() =>
      parseEnv({
        NODE_ENV: "production",
        SESSION_SECRET: SECRET,
        APP_URL: "https://share.acme.example",
      }),
    ).toThrow(/CONTENT_URL/);
  });

  test("refuses a content origin on the application host, which would not isolate it", () => {
    expect(() =>
      parseEnv({
        APP_URL: "https://share.acme.example",
        CONTENT_URL: "https://share.acme.example",
      }),
    ).toThrow(/CONTENT_URL/);
  });

  test("serves previews from another host in development, which the browser separates", () => {
    const env = parseEnv({});
    expect(new URL(env.CONTENT_URL).hostname).not.toBe(new URL(env.APP_URL).hostname);
  });

  test("accepts a complete production configuration", () => {
    const env = parseEnv({
      NODE_ENV: "production",
      PORT: "3000",
      SESSION_SECRET: SECRET,
      APP_URL: "https://share.acme.example",
      CONTENT_URL: "https://content.share.acme.example",
      DATA_DIR: "/var/lib/portego",
    });
    expect(env.NODE_ENV).toBe("production");
    expect(env.SESSION_SECRET).toBe(SECRET);
    expect(env.APP_URL).toBe("https://share.acme.example");
    expect(env.DATA_DIR).toBe("/var/lib/portego");
  });
});
