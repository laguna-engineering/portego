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
 *   npx -y portego-upload auth <origin>                   one-time browser sign-in
 *   npx -y portego-upload upload <file>                   upload from a terminal
 *   npx -y portego-upload                                 serve MCP over stdio
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { parseStore, resolveOrigin, type Store, type Token, withToken } from "./store.ts";

const CREDENTIALS_PATH =
  process.env.PORTEGO_CREDENTIALS ??
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "portego", "credentials.json");

function readStore(): Store {
  try {
    return parseStore(readFileSync(CREDENTIALS_PATH, "utf8"));
  } catch {
    return parseStore(null);
  }
}

const [COMMAND, ...ARGUMENTS] = process.argv.slice(2);
/** `auth <origin>` names the deployment and makes it the default. */
const AUTH_ORIGIN = COMMAND === "auth" ? ARGUMENTS[0] : undefined;

/** How a person starts this tool, for the messages that tell them to. */
const SELF = "npx -y portego-upload";

const SETUP_NEEDED =
  "No Portego deployment is set on this machine. Ask the user for the address of their " +
  `deployment, and have them run this in a terminal: ${SELF} auth <origin> ` +
  "(in Claude Code they can type it after a `!`). Do not guess the address.";

type Deployment = {
  origin: string;
  /**
   * The URL of a Client ID Metadata Document, which is how the server expects a
   * client to register (docs/mcp.md). Its document registers a portless
   * loopback redirect, so the callback can bind whatever port is free: a
   * loopback redirect URI matches on everything but the port (RFC 8252).
   */
  clientId: string;
  /** The token's audience. Omitting it yields a token the MCP endpoint refuses. */
  resource: string;
};

let resolved: Deployment | undefined;

/**
 * Not cached while it is missing: a stdio server started before the first
 * setup picks the deployment up on the next call, without a restart.
 */
function deployment(): Deployment {
  if (resolved) return resolved;
  const origin = resolveOrigin({
    env: process.env.PORTEGO_ORIGIN,
    argument: AUTH_ORIGIN,
    store: readStore(),
  });
  if (!origin) throw new UploadError(SETUP_NEEDED);
  resolved = {
    origin,
    clientId: process.env.PORTEGO_CLIENT_ID ?? `${origin}/mcp-clients/claude-code.json`,
    resource: `${origin}/mcp`,
  };
  return resolved;
}

/** 0 asks the OS for a free port. Set this only to pin one, as SSH forwarding needs. */
const CALLBACK_PORT = Number(process.env.PORTEGO_CALLBACK_PORT ?? "0");
const SCOPE = "artifacts:read artifacts:write offline_access";
/** A person has this long to finish in the browser before the listener closes. */
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;

/** Refresh this far before expiry so a slow upload cannot start on a dead token. */
const REFRESH_SKEW_SECONDS = 60;

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

// A token is bound to the origin that issued it, so each origin has its own.
function loadToken(): Token | null {
  return readStore().tokens[deployment().origin] ?? null;
}

async function saveToken(token: Token, options: { makeDefault: boolean }): Promise<void> {
  // Read again: another project's process can have refreshed its own token
  // since this one started.
  const store = withToken(readStore(), deployment().origin, token, options);
  await mkdir(dirname(CREDENTIALS_PATH), { recursive: true, mode: 0o700 });
  // Rename, so that a concurrent reader never sees half a file.
  const temporary = `${CREDENTIALS_PATH}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, CREDENTIALS_PATH);
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
  return fetch(`${deployment().origin}/api/auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
}

function toToken(payload: Record<string, unknown>, fallbackRefresh?: string): Token {
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
  };
}

/**
 * The browser half of the authorization code flow. A loopback redirect is the
 * only callback a command-line client can receive, so the metadata document
 * declares one and this listens on it for a single request.
 */
async function authorize(options: { makeDefault: boolean }): Promise<void> {
  const { origin, clientId, resource } = deployment();
  const { verifier, challenge } = await pkce();
  const state = crypto.randomUUID();

  let resolveCode: (code: string) => void = () => {};
  let rejectCode: (error: Error) => void = () => {};
  const received = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const answer = (status: number, text: string) => {
      response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
      response.end(text);
    };
    if (url.pathname !== "/callback") return answer(404, "Not found");

    const error = url.searchParams.get("error");
    if (error) {
      rejectCode(new UploadError(`Authorization was refused: ${error}`));
      return answer(400, "Authorization was refused. You can close this tab.");
    }
    if (url.searchParams.get("state") !== state) {
      rejectCode(new UploadError("The callback state did not match. Start again."));
      return answer(400, "State mismatch. You can close this tab.");
    }
    const code = url.searchParams.get("code");
    if (!code) {
      rejectCode(new UploadError("The callback carried no authorization code."));
      return answer(400, "No code. You can close this tab.");
    }
    resolveCode(code);
    return answer(200, "Signed in. You can close this tab.");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(CALLBACK_PORT, "localhost", resolve);
  });
  const port = (server.address() as AddressInfo).port;

  // Built after the listener starts, because until then the port is not known.
  const redirectUri = `http://localhost:${port}/callback`;
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource,
    state,
  });
  const authorizeUrl = `${origin}/api/auth/oauth2/authorize?${query}`;

  console.error(`Listening on ${redirectUri}`);
  console.error(`Opening ${authorizeUrl}`);
  console.error("If no browser opens, paste that URL into one.");
  openBrowser(authorizeUrl);

  const timeout = setTimeout(
    () => rejectCode(new UploadError("Nobody finished the sign-in in the browser. Start again.")),
    SIGN_IN_TIMEOUT_MS,
  );

  try {
    const code = await received;
    const response = await tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
      resource,
    });
    const payload = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      throw new UploadError(`The token exchange failed: ${JSON.stringify(payload)}`);
    }
    const credentials = toToken(payload);
    await saveToken(credentials, options);
    console.error(`Signed in to ${origin}. Credentials written to ${CREDENTIALS_PATH}`);
    if (!credentials.refreshToken) {
      console.error("No refresh token was issued, so this will need signing in again on expiry.");
    }
  } finally {
    clearTimeout(timeout);
    server.close();
    server.closeAllConnections();
  }
}

function openBrowser(url: string): void {
  const [command, ...args] =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  // A machine with no browser still signs in: the URL is printed above.
  spawn(command as string, args, { stdio: "ignore", detached: true })
    .on("error", () => {})
    .unref();
}

/** A valid access token, refreshed if the stored one is spent. */
async function accessToken(): Promise<string> {
  const stored = loadToken();
  if (!stored) {
    throw new UploadError(
      `Not signed in to ${deployment().origin}. Call sign_in, or run: ${SELF} auth`,
    );
  }
  if (stored.expiresAt - REFRESH_SKEW_SECONDS > Math.floor(Date.now() / 1000)) {
    return stored.accessToken;
  }
  if (!stored.refreshToken) {
    throw new UploadError(
      `The token for ${deployment().origin} expired and no refresh token was stored. Call sign_in, or run: ${SELF} auth`,
    );
  }

  const response = await tokenRequest({
    grant_type: "refresh_token",
    refresh_token: stored.refreshToken,
    client_id: deployment().clientId,
    resource: deployment().resource,
  });
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new UploadError(
      `Refreshing the token failed. Call sign_in, or run: ${SELF} auth. The server said: ${JSON.stringify(payload)}`,
    );
  }
  const refreshed = toToken(payload, stored.refreshToken);
  await saveToken(refreshed, { makeDefault: false });
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
  const response = await fetch(deployment().resource, {
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
      `${deployment().origin} refused this token (${response.status}). If the scope is wrong, sign in again.`,
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
    url: `${deployment().origin}/a/${encodeURIComponent(body.artifact.id)}`,
    versionNumber: versionCount,
    newArtifact: body.newArtifact ?? true,
  };
}

// --------------------------------------------------------------------------
// Entry points
// --------------------------------------------------------------------------

async function serve(): Promise<void> {
  const server = new McpServer(
    { name: "portego-upload", version: "1.0.0" },
    {
      instructions:
        "When a tool says the user is not signed in, call sign_in and tell the user to approve " +
        "the request in the browser that opens, then repeat the call. When a tool says no " +
        "deployment is set, only the user can fix it: give them the command from the message.",
    },
  );

  server.registerTool(
    "sign_in",
    {
      title: "Sign in to Portego",
      description:
        "Opens the user's browser to sign this machine in to their Portego deployment, and waits " +
        "until they approve. Call it when another tool reports that the user is not signed in. It " +
        "takes no address: the deployment is the one the user set up, so that nothing in a " +
        "conversation can point uploads somewhere else.",
      inputSchema: {},
    },
    async () => {
      try {
        await authorize({ makeDefault: false });
        return {
          content: [{ type: "text" as const, text: `Signed in to ${deployment().origin}.` }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: (error as Error).message }],
          isError: true,
        };
      }
    },
  );

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
  const command = COMMAND;
  const rest = ARGUMENTS;

  if (command === "auth") return authorize({ makeDefault: AUTH_ORIGIN !== undefined });

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
