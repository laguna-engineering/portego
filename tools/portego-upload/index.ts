#!/usr/bin/env bun
/**
 * A local MCP server that uploads a file the calling agent never has to read.
 *
 * The deployed MCP server cannot do this. It runs on the host, so a path on
 * someone's laptop means nothing to it, and its two upload paths both put
 * something sensitive into the conversation: `upload_artifact` carries the whole
 * document as a tool argument, and `create_upload_ticket` hands the caller a
 * bearer credential to spend with a shell. An agent running under a permission
 * classifier is refused on both counts, so the flow worked for a person with a
 * terminal and for nobody else.
 *
 * This process runs beside the agent instead. It holds its own OAuth token,
 * reads the file itself, mints the ticket itself, and returns only the artifact
 * record. The agent passes a path and gets back a URL. No document bytes and no
 * credential cross the tool boundary, which is what makes the upload allowable
 * rather than merely possible.
 *
 *   bun run tools/portego-upload/index.ts auth            one-time browser sign-in
 *   bun run tools/portego-upload/index.ts upload <file>   upload from a terminal
 *   bun run tools/portego-upload/index.ts                 serve MCP over stdio
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

if (!process.env.PORTEGO_ORIGIN) {
  console.error("Set PORTEGO_ORIGIN to the deployment's origin, e.g. https://share.acme.example");
  process.exit(1);
}
const ORIGIN = process.env.PORTEGO_ORIGIN.replace(/\/+$/, "");
/**
 * The client id is the URL of a Client ID Metadata Document, which is how this
 * server expects a client to register (docs/mcp.md). Its document registers a
 * portless loopback redirect, so the callback can bind whatever port is free:
 * a loopback redirect URI matches on everything but the port (RFC 8252).
 */
const CLIENT_ID = process.env.PORTEGO_CLIENT_ID ?? `${ORIGIN}/mcp-clients/claude-code.json`;
/** 0 asks the OS for a free port. Set this only to pin one, as SSH forwarding needs. */
const CALLBACK_PORT = Number(process.env.PORTEGO_CALLBACK_PORT ?? "0");
const SCOPE = "artifacts:read artifacts:write";
/** The token's audience. Omitting it yields a token the MCP endpoint refuses. */
const RESOURCE = `${ORIGIN}/mcp`;

const CREDENTIALS_PATH =
  process.env.PORTEGO_CREDENTIALS ??
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "portego", "credentials.json");

/** Refresh this far before expiry so a slow upload cannot start on a dead token. */
const REFRESH_SKEW_SECONDS = 60;

type Credentials = {
  accessToken: string;
  refreshToken?: string;
  /** Unix seconds. */
  expiresAt: number;
  origin: string;
};

/**
 * What the upload endpoint returns. It is an ArtifactSummary, which carries no
 * page URL: the MCP tools on the server add one from their own origin, and the
 * REST route does not. This builds it the same way app.ts does.
 */
type ArtifactSummary = {
  id: string;
  title: string;
  byteSize: number;
  sha256: string;
  versionCount: number;
};

type Artifact = Omit<ArtifactSummary, "versionCount"> & {
  url: string;
  versionNumber: number;
  newArtifact: boolean;
};

class UploadError extends Error {}

// --------------------------------------------------------------------------
// Credential storage
// --------------------------------------------------------------------------

async function loadCredentials(): Promise<Credentials | null> {
  try {
    const parsed = JSON.parse(await readFile(CREDENTIALS_PATH, "utf8")) as Credentials;
    // A stored token is bound to the origin it was issued by. Pointing the tool
    // at a different deployment has to re-authorize rather than send the old one.
    if (parsed.origin !== ORIGIN) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function saveCredentials(credentials: Credentials): Promise<void> {
  await mkdir(dirname(CREDENTIALS_PATH), { recursive: true, mode: 0o700 });
  await writeFile(CREDENTIALS_PATH, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  // writeFile only applies the mode when it creates the file, so an existing
  // file keeps whatever it had. Set it every time.
  await chmod(CREDENTIALS_PATH, 0o600);
}

// --------------------------------------------------------------------------
// OAuth
// --------------------------------------------------------------------------

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = Buffer.from(bytes).toString("base64url");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: Buffer.from(digest).toString("base64url") };
}

function tokenRequest(body: Record<string, string>): Promise<Response> {
  return fetch(`${ORIGIN}/api/auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
}

function storeToken(payload: Record<string, unknown>, fallbackRefresh?: string): Credentials {
  const accessToken = payload.access_token;
  if (typeof accessToken !== "string") {
    throw new UploadError(`The token response carried no access token: ${JSON.stringify(payload)}`);
  }
  const lifetime = typeof payload.expires_in === "number" ? payload.expires_in : 3600;
  return {
    accessToken,
    refreshToken:
      typeof payload.refresh_token === "string" ? payload.refresh_token : fallbackRefresh,
    expiresAt: Math.floor(Date.now() / 1000) + lifetime,
    origin: ORIGIN,
  };
}

/**
 * The browser half of the authorization code flow. A loopback redirect is the
 * only callback a command-line client can receive, so the metadata document
 * declares one and this listens on it for a single request.
 */
async function authorize(): Promise<void> {
  const { verifier, challenge } = await pkce();
  const state = crypto.randomUUID();

  const received = Promise.withResolvers<string>();
  const server = Bun.serve({
    port: CALLBACK_PORT,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/callback") return new Response("Not found", { status: 404 });

      const error = url.searchParams.get("error");
      if (error) {
        received.reject(new UploadError(`Authorization was refused: ${error}`));
        return new Response("Authorization was refused. You can close this tab.", { status: 400 });
      }
      if (url.searchParams.get("state") !== state) {
        received.reject(new UploadError("The callback state did not match. Start again."));
        return new Response("State mismatch. You can close this tab.", { status: 400 });
      }
      const code = url.searchParams.get("code");
      if (!code) {
        received.reject(new UploadError("The callback carried no authorization code."));
        return new Response("No code. You can close this tab.", { status: 400 });
      }
      received.resolve(code);
      return new Response("Signed in. You can close this tab and return to the terminal.");
    },
  });

  // Built after the listener starts, because until then the port is not known.
  const redirectUri = `http://localhost:${server.port}/callback`;
  const query = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: RESOURCE,
    state,
  });
  const authorizeUrl = `${ORIGIN}/api/auth/oauth2/authorize?${query}`;

  console.error(`Listening on ${redirectUri}`);
  console.error(`Opening ${authorizeUrl}`);
  console.error("If no browser opens, paste that URL into one.");
  Bun.spawn(["open", authorizeUrl], { stdout: "ignore", stderr: "ignore" }).exited.catch(() => {});

  try {
    const code = await received.promise;
    const response = await tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: verifier,
      resource: RESOURCE,
    });
    const payload = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      throw new UploadError(`The token exchange failed: ${JSON.stringify(payload)}`);
    }
    const credentials = storeToken(payload);
    await saveCredentials(credentials);
    console.error(`Signed in. Credentials written to ${CREDENTIALS_PATH}`);
    if (!credentials.refreshToken) {
      console.error("No refresh token was issued, so this will need signing in again on expiry.");
    }
  } finally {
    server.stop(true);
  }
}

/** A valid access token, refreshed if the stored one is spent. */
async function accessToken(): Promise<string> {
  const stored = await loadCredentials();
  if (!stored) {
    throw new UploadError(
      `Not signed in to ${ORIGIN}. Run: bun run tools/portego-upload/index.ts auth`,
    );
  }
  if (stored.expiresAt - REFRESH_SKEW_SECONDS > Math.floor(Date.now() / 1000)) {
    return stored.accessToken;
  }
  if (!stored.refreshToken) {
    throw new UploadError(
      `The token for ${ORIGIN} expired and no refresh token was stored. Run the auth command again.`,
    );
  }

  const response = await tokenRequest({
    grant_type: "refresh_token",
    refresh_token: stored.refreshToken,
    client_id: CLIENT_ID,
    resource: RESOURCE,
  });
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new UploadError(
      `Refreshing the token failed, so sign in again. The server said: ${JSON.stringify(payload)}`,
    );
  }
  const refreshed = storeToken(payload, stored.refreshToken);
  await saveCredentials(refreshed);
  return refreshed.accessToken;
}

// --------------------------------------------------------------------------
// Upload
// --------------------------------------------------------------------------

type Ticket = { url: string; ticket: string; maxBytes: number };

/** Calls one tool on the deployed MCP server and returns its structured result. */
async function callRemoteTool(
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const response = await fetch(RESOURCE, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });

  if (response.status === 401 || response.status === 403) {
    throw new UploadError(
      `${ORIGIN} refused this token (${response.status}). If the scope is wrong, sign in again.`,
    );
  }

  const body = (await response.json()) as {
    result?: {
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
      content?: unknown[];
    };
    error?: { message?: string };
  };
  if (body.error) throw new UploadError(`${name} failed: ${body.error.message ?? "unknown error"}`);
  if (body.result?.isError) {
    const text = body.result.content?.map((part) =>
      typeof part === "object" && part && "text" in part
        ? String((part as { text: unknown }).text)
        : "",
    );
    throw new UploadError(`${name} failed: ${text?.join(" ").trim() || "unknown error"}`);
  }
  const structured = body.result?.structuredContent;
  if (!structured) throw new UploadError(`${name} returned no structured result.`);
  return structured;
}

async function upload(options: {
  path: string;
  title?: string;
  description?: string;
  artifactId?: string;
}): Promise<Artifact> {
  let bytes: Buffer;
  try {
    bytes = await readFile(options.path);
  } catch (error) {
    throw new UploadError(`Cannot read ${options.path}: ${(error as Error).message}`);
  }

  const token = await accessToken();
  const ticket = (await callRemoteTool(token, "create_upload_ticket")) as unknown as Ticket;

  // Checked here as well as by the server, because failing before sending
  // several megabytes says something more useful than a 413 does.
  if (bytes.byteLength > ticket.maxBytes) {
    throw new UploadError(
      `${options.path} is ${bytes.byteLength} bytes and the limit is ${ticket.maxBytes}.`,
    );
  }

  const form = new FormData();
  form.set("file", new File([bytes], options.path.split("/").pop() ?? "artifact.html"));
  if (options.title) form.set("title", options.title);
  if (options.description) form.set("description", options.description);
  if (options.artifactId) form.set("artifactId", options.artifactId);

  const response = await fetch(ticket.url, {
    method: "POST",
    headers: { authorization: `Bearer ${ticket.ticket}` },
    body: form,
  });
  const body = (await response.json()) as {
    artifact?: ArtifactSummary;
    newArtifact?: boolean;
    error?: { message?: string };
  };
  if (!response.ok || !body.artifact) {
    throw new UploadError(
      `The upload was refused (${response.status}): ${body.error?.message ?? JSON.stringify(body)}`,
    );
  }
  const { versionCount, ...summary } = body.artifact;
  return {
    ...summary,
    url: `${ORIGIN}/a/${encodeURIComponent(body.artifact.id)}`,
    versionNumber: versionCount,
    newArtifact: body.newArtifact ?? true,
  };
}

// --------------------------------------------------------------------------
// Entry points
// --------------------------------------------------------------------------

async function serve(): Promise<void> {
  const server = new McpServer({ name: "portego-upload", version: "1.0.0" });

  server.registerTool(
    "upload_artifact_from_path",
    {
      title: "Upload an artifact from a local file",
      description:
        "Publish a self-contained HTML document to the Portego gallery by its path on this " +
        "machine. The file is read here and sent directly, so its contents never pass through the " +
        "conversation. An upload whose title matches an existing, non-archived artifact's title " +
        "becomes a new version of that artifact rather than a new artifact; give artifactId to be " +
        "explicit about which one. The returned url stays the same for every version. Returns the " +
        "artifact record, including the URL to share. The document must be self-contained: it " +
        "renders with no network access.",
      inputSchema: {
        path: z.string().describe("Absolute path to the HTML file on this machine."),
        title: z
          .string()
          .max(200)
          .optional()
          .describe("Shown in the gallery. Defaults to the document's <title>."),
        description: z.string().max(2000).optional().describe("One-sentence subtitle."),
        artifactId: z
          .string()
          .optional()
          .describe(
            "Upload as a new version of this existing artifact. Without it, an upload whose " +
              "title matches an existing artifact's title becomes a new version of that artifact.",
          ),
      },
      outputSchema: {
        id: z.string(),
        title: z.string(),
        url: z.string(),
        byteSize: z.number().int(),
        sha256: z.string(),
        versionNumber: z.number().int(),
        newArtifact: z.boolean(),
      },
    },
    async ({ path, title, description, artifactId }) => {
      try {
        const artifact = await upload({ path, title, description, artifactId });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(artifact, null, 2) }],
          structuredContent: artifact as unknown as Record<string, unknown>,
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: (error as Error).message }],
          isError: true,
        };
      }
    },
  );

  await server.connect(new StdioServerTransport());
}

function readFlag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (command === "auth") return authorize();

  if (command === "upload") {
    const path = rest.find((argument) => !argument.startsWith("--"));
    if (!path) throw new UploadError("Usage: upload <file> [--title T] [--description D]");
    const artifact = await upload({
      path,
      title: readFlag(rest, "title"),
      description: readFlag(rest, "description"),
    });
    console.log(artifact.url);
    return;
  }

  if (command && command !== "serve") {
    throw new UploadError(`Unknown command "${command}". Use auth, upload, or serve.`);
  }

  // No arguments means stdio: that is how an MCP client starts this.
  return serve();
}

main().catch((error) => {
  console.error(error instanceof UploadError ? error.message : error);
  process.exit(1);
});
