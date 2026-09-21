/**
 * Browser test support. The application runs in this process on a real port,
 * serving the built client, and Playwright drives a real browser against it.
 * Sign-in uses the offline provider from the server tests, so no browser test
 * touches Google.
 */
import { type Browser, type BrowserContext, chromium } from "playwright";
import { createLiveTestServer, type LiveTestServer } from "../src/server/testing.ts";

export type BrowserApp = {
  server: LiveTestServer;
  browser: Browser;
  /** A context carrying a signed-in session cookie. */
  signedIn: () => Promise<BrowserContext>;
  /** A context with no session at all. */
  anonymous: () => Promise<BrowserContext>;
  /**
   * Closes every context opened so far. A test that fails before its own close
   * leaves a live-event stream open, and enough of those use up the per-user
   * budget that later tests need.
   */
  closeContexts: () => Promise<void>;
  stop: () => Promise<void>;
};

export async function startBrowserApp(): Promise<BrowserApp> {
  const server = await createLiveTestServer({ serveClient: true });
  const browser = await chromium.launch();
  const contexts: BrowserContext[] = [];

  const track = async (context: BrowserContext) => {
    contexts.push(context);
    return context;
  };

  return {
    server,
    browser,

    async signedIn() {
      const cookie = await server.signIn();
      // Only the first "=" separates the name from the value. A token that
      // contains one would otherwise be silently truncated.
      const separator = cookie.indexOf("=");
      if (separator === -1) throw new Error("Sign-in returned a cookie with no value");
      const context = await browser.newContext();
      await context.addCookies([
        {
          name: cookie.slice(0, separator),
          value: cookie.slice(separator + 1),
          domain: "127.0.0.1",
          path: "/",
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
      return track(context);
    },

    async anonymous() {
      return track(await browser.newContext());
    },

    async closeContexts() {
      for (const context of contexts.splice(0)) await context.close();
    },

    async stop() {
      await this.closeContexts();
      await browser.close();
      server.stop();
    },
  };
}

export type Traffic = {
  /** Every URL the browser tried to load, blocked or not. */
  attempted: string[];
  /** URLs that actually came back with a response. */
  answered: string[];
  /** URLs the browser refused to load, with the reason it gave. */
  refused: { url: string; reason: string }[];
};

/**
 * Watches what the browser did with each request. A blocked request still
 * raises a `request` event, so proving that nothing reached a host means
 * looking at what came back, not at what was attempted.
 */
export function recordRequests(context: BrowserContext): Traffic {
  const traffic: Traffic = { attempted: [], answered: [], refused: [] };
  context.on("request", (request) => traffic.attempted.push(request.url()));
  context.on("response", (response) => traffic.answered.push(response.url()));
  context.on("requestfailed", (request) =>
    traffic.refused.push({
      url: request.url(),
      reason: request.failure()?.errorText ?? "unknown",
    }),
  );
  return traffic;
}

export async function uploadArtifact(
  app: BrowserApp,
  input: { title: string; html: string; description?: string; artifactId?: string },
): Promise<string> {
  const session = await app.server.auth.api.getSession({
    headers: new Headers({ cookie: await app.server.signIn() }),
  });
  const { artifact } = await app.server.artifacts.upload({
    bytes: new TextEncoder().encode(input.html),
    filename: "artifact.html",
    title: input.title,
    description: input.description ?? null,
    createdBy: session?.user.id ?? "",
    artifactId: input.artifactId,
  });
  return artifact.id;
}
