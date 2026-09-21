import { describe, expect, test } from "bun:test";
import { parseStore, resolveOrigin, withToken } from "./store.ts";

const token = { accessToken: "a", refreshToken: "r", expiresAt: 1 };
const other = { accessToken: "b", expiresAt: 2 };

describe("choosing the deployment", () => {
  const store = { defaultOrigin: "https://main.example", tokens: {} };

  test("uses the default from the one-time setup when nothing else names one", () => {
    expect(resolveOrigin({ store })).toBe("https://main.example");
  });

  // This is what lets one project point at another deployment, through the
  // environment its MCP client gives the tool.
  test("PORTEGO_ORIGIN overrides the default", () => {
    expect(resolveOrigin({ env: "https://project.example/", store })).toBe(
      "https://project.example",
    );
  });

  test("has no answer before the first setup", () => {
    expect(resolveOrigin({ store: { tokens: {} } })).toBeUndefined();
  });
});

describe("the credentials file", () => {
  // People who signed in before the file held several deployments must not
  // have to sign in again.
  test("reads a file written for a single deployment", () => {
    const store = parseStore(JSON.stringify({ ...token, origin: "https://main.example" }));
    expect(store).toEqual({
      defaultOrigin: "https://main.example",
      tokens: { "https://main.example": token },
    });
  });

  test("treats unreadable content as not signed in", () => {
    expect(parseStore("{")).toEqual({ tokens: {} });
    expect(parseStore(null)).toEqual({ tokens: {} });
  });

  test("signing in to a second deployment keeps the first token and the default", () => {
    const first = withToken({ tokens: {} }, "https://main.example", token, { makeDefault: false });
    const both = withToken(first, "https://project.example", other, { makeDefault: false });
    expect(both.defaultOrigin).toBe("https://main.example");
    expect(both.tokens["https://main.example"]).toEqual(token);
    expect(both.tokens["https://project.example"]).toEqual(other);
  });

  test("auth with an origin argument moves the default", () => {
    const first = withToken({ tokens: {} }, "https://main.example", token, { makeDefault: false });
    const moved = withToken(first, "https://new.example", other, { makeDefault: true });
    expect(moved.defaultOrigin).toBe("https://new.example");
  });
});
