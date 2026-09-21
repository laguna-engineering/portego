/**
 * A local identity provider for development. It signs everyone in as one
 * person without asking anything. `bun run dev` starts it before the server,
 * which reads the discovery document at startup. Run this file directly to
 * have it on its own, for `bun run dev:server` alone.
 */
import { type MockIssuer, startMockIssuer } from "../src/server/auth/providers/mock-issuer.ts";

/** The port `.env` points at, or null when `.env` names a real provider. */
export function localIssuerPort(issuerUrl = process.env.OIDC_ISSUER_URL): number | null {
  if (!issuerUrl) return null;
  let url: URL;
  try {
    url = new URL(issuerUrl);
  } catch {
    return null;
  }
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return null;
  return Number(url.port || 80);
}

export async function startDevIssuer(port: number): Promise<MockIssuer> {
  const issuer = await startMockIssuer({ port });
  issuer.issue({
    sub: "dev-user",
    email: process.env.DEV_ISSUER_EMAIL ?? "dev@localhost.example",
    email_verified: true,
    name: process.env.DEV_ISSUER_NAME ?? "Local Developer",
  });
  console.log(`[issuer] Local issuer at ${issuer.issuer}`);
  return issuer;
}

if (import.meta.main) {
  const port = localIssuerPort() ?? 9876;
  const issuer = await startDevIssuer(port);
  console.log("Set in .env:");
  console.log("  AUTH_PROVIDERS=oidc");
  console.log(`  OIDC_ISSUER_URL=${issuer.issuer}`);
  console.log(`  OIDC_CLIENT_ID=${issuer.clientId}`);
  console.log(`  OIDC_CLIENT_SECRET=${issuer.clientSecret}`);
  console.log("  AUTH_ALLOW_ALL_AUTHENTICATED=true");
}
