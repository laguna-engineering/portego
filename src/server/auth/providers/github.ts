import type { GithubOptions } from "better-auth/social-providers";
import type { EnvSource } from "../../env.ts";

export type GitHubSettings = { clientId: string; clientSecret: string };

/**
 * GitHub is not a sign-in provider: people connect GitHub accounts to the
 * Portego account they signed in with. It is enabled by its credentials alone,
 * never through AUTH_PROVIDERS. Null means it is off.
 */
export function readGitHubSettings(
  source: EnvSource,
): { ok: true; settings: GitHubSettings | null } | { ok: false; missing: string[] } {
  const clientId = source.GITHUB_CLIENT_ID?.trim();
  const clientSecret = source.GITHUB_CLIENT_SECRET?.trim();
  if (!clientId && !clientSecret) return { ok: true, settings: null };

  const missing: string[] = [];
  if (!clientId) missing.push("GITHUB_CLIENT_ID");
  if (!clientSecret) missing.push("GITHUB_CLIENT_SECRET");
  if (!clientId || !clientSecret) return { ok: false, missing };
  return { ok: true, settings: { clientId, clientSecret } };
}

export function buildGitHubOptions(settings: GitHubSettings): GithubOptions {
  return {
    clientId: settings.clientId,
    clientSecret: settings.clientSecret,
    // No scopes: the token can read only public profile data, which is all a
    // connection needs. The email does not matter, so it is not requested.
    disableDefaultScope: true,
    disableSignUp: true,
  };
}

/** The account's current login, read with the token the connection just received. */
export async function fetchGitHubLogin(accessToken: string): Promise<string> {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/vnd.github+json",
      // GitHub refuses API requests without a User-Agent.
      "user-agent": "Portego",
    },
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for the connected user`);
  const profile = (await response.json()) as { login?: unknown };
  if (typeof profile.login !== "string" || profile.login === "") {
    throw new Error("GitHub returned no login for the connected user");
  }
  return profile.login;
}
