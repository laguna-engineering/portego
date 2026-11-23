import { describe, expect, test } from "bun:test";
import { parseStore, resolveOrigin, withToken } from "./store.ts";

const token = { accessToken: "a", refreshToken: "r", expiresAt: 1 };
const other = { accessToken: "b", expiresAt: 2 };
const portego = { slug: "portego" };
/** A company's build with its deployment built in. */
const acme = { slug: "acme-share", origin: "https://share.acme.example" };
/** A company's build without one. */
const globex = { slug: "globex-docs" };

describe("choosing the deployment", () => {
  const store = { defaultOrigin: "https://main.example", tokens: {} };

  test("uses the default from the one-time setup when nothing else names one", () => {
    expect(resolveOrigin({ store, brand: portego })).toBe("https://main.example");
  });

  // This is what lets one project point at another deployment, through the
  // environment its MCP client gives the tool.
  test("PORTEGO_ORIGIN overrides the default", () => {
    expect(resolveOrigin({ env: "https://project.example/", store, brand: portego })).toBe(
      "https://project.example",
    );
  });

  test("has no answer before the first setup", () => {
    expect(resolveOrigin({ store: { tokens: {} }, brand: portego })).toBeUndefined();
  });

  // Every build shares the credentials file, so Portego's default can name a
  // deployment that has nothing to do with the company.
  test("a company's build uses its built-in deployment over Portego's default", () => {
    expect(resolveOrigin({ store, brand: acme })).toBe("https://share.acme.example");
    expect(resolveOrigin({ env: "https://project.example", store, brand: acme })).toBe(
      "https://project.example",
    );
  });

  test("a company's build uses its own default over its built-in deployment", () => {
    const own = { ...store, defaultOrigins: { "acme-share": "https://staging.acme.example" } };
    expect(resolveOrigin({ store: own, brand: acme })).toBe("https://staging.acme.example");
    expect(resolveOrigin({ store: own, brand: portego })).toBe("https://main.example");
  });

  // Older versions stored a company build's `auth <origin>` as Portego's default.
  test("a company's build with no deployment built in falls back to Portego's default", () => {
    expect(resolveOrigin({ store, brand: globex })).toBe("https://main.example");
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
    const options = { makeDefault: false, brand: portego };
    const first = withToken({ tokens: {} }, "https://main.example", token, options);
    const both = withToken(first, "https://project.example", other, options);
    expect(both.defaultOrigin).toBe("https://main.example");
    expect(both.tokens["https://main.example"]).toEqual(token);
    expect(both.tokens["https://project.example"]).toEqual(other);
  });

  test("auth with an origin argument moves the default", () => {
    const first = withToken({ tokens: {} }, "https://main.example", token, {
      makeDefault: false,
      brand: portego,
    });
    const moved = withToken(first, "https://new.example", other, {
      makeDefault: true,
      brand: portego,
    });
    expect(moved.defaultOrigin).toBe("https://new.example");
  });

  test("a company's build keeps its default apart from Portego's and other builds'", () => {
    const start = {
      defaultOrigin: "https://main.example",
      defaultOrigins: { "globex-docs": "https://docs.globex.example" },
      tokens: {},
    };
    const moved = withToken(start, "https://staging.acme.example", token, {
      makeDefault: true,
      brand: acme,
    });
    expect(moved.defaultOrigin).toBe("https://main.example");
    expect(moved.defaultOrigins).toEqual({
      "globex-docs": "https://docs.globex.example",
      "acme-share": "https://staging.acme.example",
    });
    expect(parseStore(JSON.stringify(moved))).toEqual(moved);

    const portegoAgain = withToken(moved, "https://main.example", other, {
      makeDefault: true,
      brand: portego,
    });
    expect(portegoAgain.defaultOrigins).toEqual(moved.defaultOrigins);
  });

  // A stored built-in deployment would keep people on it after a newer build
  // of the tool names another one.
  test("a sign-in does not store the built-in deployment as the default", () => {
    const signedIn = withToken({ tokens: {} }, "https://share.acme.example", token, {
      makeDefault: false,
      brand: acme,
    });
    expect(signedIn.tokens["https://share.acme.example"]).toEqual(token);
    const moved = { ...acme, origin: "https://docs.acme.example" };
    expect(resolveOrigin({ store: signedIn, brand: moved })).toBe("https://docs.acme.example");
  });

  test("the first sign-in of a company's build with no deployment built in becomes its default", () => {
    const signedIn = withToken({ tokens: {} }, "https://docs.globex.example", token, {
      makeDefault: false,
      brand: globex,
    });
    expect(signedIn.defaultOrigin).toBeUndefined();
    expect(resolveOrigin({ store: signedIn, brand: globex })).toBe("https://docs.globex.example");
  });
});
