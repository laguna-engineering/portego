/**
 * Signs an agent in with a key pair instead of a browser. The private key
 * stays in the key file. The server holds only the public half, and replaces
 * it at each renewal, so a copied key stops working when the real agent next
 * renews.
 */
import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  type JsonWebKey,
  randomUUID,
  sign,
} from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type ServiceKey = {
  origin: string;
  clientId: string;
  /** Ed25519, with its private part `d`. */
  privateJwk: JsonWebKey;
  /** Epoch ms when the server accepted this key. */
  renewedAt: number;
  /**
   * The key a renewal sent before its answer arrived. While it is set, that
   * renewal is unfinished: the server may hold either key, so this one is sent
   * again rather than replaced.
   */
  nextPrivateJwk?: JsonWebKey;
};

/** The key renews when it is older than this. The server expires it after 7 days. */
export const RENEW_AFTER_MS = 24 * 60 * 60 * 1000;
/** Assertions are short-lived; the server refuses any that claim more than 60 seconds. */
const ASSERTION_LIFETIME_SECONDS = 30;
const POLL_INTERVAL_MS = 3000;
/** A lock older than this belongs to a process that died while renewing. */
const STALE_LOCK_MS = 60 * 1000;
const LOCK_WAIT_MS = 30 * 1000;

/** The key was replaced elsewhere, or the account was disabled or expired. */
export class ServiceKeyRevokedError extends Error {
  constructor(origin: string, command: string) {
    super(
      `${origin} refused this service key: it was replaced or revoked. A copy of the key may ` +
        `have renewed first, or an admin disabled the account. Enroll again with ` +
        `\`${command} service-key enroll ${origin} --name <name>\`, and ask an admin to check ` +
        "the account.",
    );
  }
}

export class ServiceKeyError extends Error {}

export type Dependencies = {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  now: () => number;
  /** How a person runs this tool, for messages that tell them to. */
  command: string;
  log: (line: string) => void;
};

export function generateKey(): { privateJwk: JsonWebKey; publicJwk: JsonWebKey } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicJwk = publicKey.export({ format: "jwk" });
  return {
    privateJwk: privateKey.export({ format: "jwk" }),
    publicJwk: { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x },
  };
}

const base64url = (value: string | Buffer) => Buffer.from(value).toString("base64url");

function publicHalf(privateJwk: JsonWebKey): JsonWebKey {
  return { kty: privateJwk.kty, crv: privateJwk.crv, x: privateJwk.x };
}

/** RFC 7638: SHA-256 of the required members, in lexicographic order. */
function thumbprint(jwk: JsonWebKey): string {
  return createHash("sha256")
    .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x }))
    .digest("base64url");
}

export function signJwt(privateJwk: JsonWebKey, claims: Record<string, unknown>): string {
  const header = base64url(JSON.stringify({ alg: "EdDSA", typ: "JWT" }));
  const payload = base64url(JSON.stringify(claims));
  const key = createPrivateKey({ key: privateJwk, format: "jwk" });
  const signature = sign(null, Buffer.from(`${header}.${payload}`), key);
  return `${header}.${payload}.${base64url(signature)}`;
}

function assertion(
  privateJwk: JsonWebKey,
  claims: { iss: string; sub?: string; aud: string; next_jkt?: string },
  now: number,
): string {
  const issuedAt = Math.floor(now / 1000);
  return signJwt(privateJwk, {
    ...claims,
    jti: randomUUID(),
    iat: issuedAt,
    exp: issuedAt + ASSERTION_LIFETIME_SECONDS,
  });
}

export async function readServiceKey(path: string): Promise<ServiceKey | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  const parsed = JSON.parse(text) as Partial<ServiceKey>;
  if (
    typeof parsed.origin !== "string" ||
    typeof parsed.clientId !== "string" ||
    typeof parsed.renewedAt !== "number" ||
    typeof parsed.privateJwk !== "object"
  ) {
    throw new ServiceKeyError(`${path} is not a service key file.`);
  }
  return parsed as ServiceKey;
}

async function writeServiceKey(path: string, key: ServiceKey): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Rename, so that a concurrent reader never sees half a file.
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(key, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

/**
 * Runs `work` while holding `<path>.lock`, so that two processes never renew
 * the same key at once. The second one would sign with a key the first one
 * just replaced.
 */
export async function withLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const handle = await open(lock, "wx", 0o600);
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const held = await stat(lock).catch(() => null);
      if (held && Date.now() - held.mtimeMs > STALE_LOCK_MS) {
        await unlink(lock).catch(() => {});
        continue;
      }
      if (Date.now() > deadline) {
        throw new ServiceKeyError(`Another process has held ${lock} for too long.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 100));
    }
  }
  try {
    return await work();
  } finally {
    await unlink(lock).catch(() => {});
  }
}

async function readError(response: Response): Promise<{ code?: string; message?: string }> {
  const body = (await response.json().catch(() => ({}))) as {
    error?: { code?: string; message?: string };
  };
  return body.error ?? {};
}

/**
 * Sends a new public key and waits for an admin to approve it in the browser.
 * The key file is written only after approval, so a key that already works is
 * kept if the enrollment never completes.
 */
export async function enroll(
  options: { origin: string; name: string; path: string },
  deps: Dependencies,
): Promise<ServiceKey> {
  const { privateJwk, publicJwk } = generateKey();
  const response = await deps.fetch(`${options.origin}/api/service-accounts/enrollments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: options.name, publicJwk }),
  });
  if (response.status === 404) {
    throw new ServiceKeyError(`${options.origin} does not have service accounts turned on.`);
  }
  const created = (await response.json()) as {
    id?: string;
    userCode?: string;
    approvalUrl?: string;
    expiresAt?: string;
    error?: { message?: string };
  };
  if (!response.ok || !created.id || !created.userCode || !created.approvalUrl) {
    throw new ServiceKeyError(`Enrollment failed: ${created.error?.message ?? response.status}`);
  }
  // Signed requests name URLs under the origin as their audience, and the
  // server compares them with its own address exactly.
  if (!created.approvalUrl.startsWith(`${options.origin}/`)) {
    throw new ServiceKeyError(
      `${options.origin} calls itself ${new URL(created.approvalUrl).origin}. Enroll with that address.`,
    );
  }

  const code = `${created.userCode.slice(0, 4)}-${created.userCode.slice(4)}`;
  deps.log(`Ask an admin to open ${created.approvalUrl}`);
  deps.log(`and check that it shows this code: ${code}`);
  deps.log("Waiting for approval...");

  const pollUrl = `${options.origin}/api/service-accounts/enrollments/${created.id}`;
  const expiresAt = Date.parse(created.expiresAt ?? "") || deps.now() + 15 * 60 * 1000;
  while (deps.now() < expiresAt) {
    const proof = assertion(privateJwk, { iss: created.id, aud: pollUrl }, deps.now());
    const poll = await deps.fetch(pollUrl, { headers: { authorization: `Bearer ${proof}` } });
    if (poll.status === 404) break;
    // Polling on would hide the problem until the enrollment expires, and an
    // approval in the meantime would create an account whose key is lost.
    if (poll.status === 401) {
      const { message } = await readError(poll);
      throw new ServiceKeyError(
        `${options.origin} refused the signed poll${message ? `: ${message}` : ""}. ` +
          "Check that this machine's clock is correct, then enroll again.",
      );
    }
    if (poll.ok) {
      const result = (await poll.json()) as { status?: string; clientId?: string };
      if (result.status === "approved" && result.clientId) {
        const key = {
          origin: options.origin,
          clientId: result.clientId,
          privateJwk,
          renewedAt: deps.now(),
        };
        await withLock(options.path, () => writeServiceKey(options.path, key));
        return key;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new ServiceKeyError("Nobody approved the enrollment in time. Start again.");
}

/**
 * Replaces the key with a new one, and finishes an earlier renewal that did
 * not complete.
 * Holds the lock throughout and reads the file again under it, because another
 * process may have renewed already. `force` renews even a key that is still
 * fresh.
 */
export async function renew(
  path: string,
  options: { force: boolean },
  deps: Dependencies,
): Promise<ServiceKey> {
  return withLock(path, async () => {
    const current = await readServiceKey(path);
    if (!current) throw new ServiceKeyError(`No service key at ${path}.`);
    const pending = current.nextPrivateJwk;
    const due = options.force || deps.now() - current.renewedAt >= RENEW_AFTER_MS;
    if (!pending && !due) return current;

    const next = pending ?? generateKey().privateJwk;
    if (!pending) await writeServiceKey(path, { ...current, nextPrivateJwk: next });

    const url = `${current.origin}/api/service-accounts/renew`;
    const response = await deps.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientId: current.clientId,
        publicJwk: publicHalf(next),
        assertion: assertion(
          current.privateJwk,
          { iss: current.clientId, sub: current.clientId, aud: url, next_jkt: thumbprint(next) },
          deps.now(),
        ),
      }),
    });
    const renewed = {
      origin: current.origin,
      clientId: current.clientId,
      privateJwk: next,
      renewedAt: deps.now(),
    };
    if (response.ok) {
      await writeServiceKey(path, renewed);
      return renewed;
    }
    if ((await readError(response)).code !== "INVALID_CLIENT") {
      throw new ServiceKeyError(`Renewing the service key failed with ${response.status}.`);
    }
    // An earlier renewal whose answer was lost, or a copy of this request that
    // arrived first, may have installed `next` already. Under clock skew the
    // server refuses every key, so `next` replaces the current key only once
    // it gets a token.
    if (await requestToken(current, next, deps)) {
      await writeServiceKey(path, renewed);
      return renewed;
    }
    throw new ServiceKeyRevokedError(current.origin, deps.command);
  });
}

/** An access token, or null when the server refuses `privateJwk` for the account. */
async function requestToken(
  key: Pick<ServiceKey, "origin" | "clientId">,
  privateJwk: JsonWebKey,
  deps: Dependencies,
): Promise<{ accessToken: string; expiresIn: number } | null> {
  const tokenUrl = `${key.origin}/api/auth/oauth2/token`;
  const response = await deps.fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: key.clientId,
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: assertion(
        privateJwk,
        { iss: key.clientId, sub: key.clientId, aud: tokenUrl },
        deps.now(),
      ),
      resource: `${key.origin}/mcp`,
      scope: "artifacts:read artifacts:write",
    }),
  });
  const payload = (await response.json()) as Record<string, unknown>;
  if (response.ok && typeof payload.access_token === "string") {
    return {
      accessToken: payload.access_token,
      expiresIn: typeof payload.expires_in === "number" ? payload.expires_in : 3600,
    };
  }
  if (payload.error === "invalid_client") return null;
  throw new ServiceKeyError(`The token request failed: ${JSON.stringify(payload)}`);
}

/**
 * Whether a stored token can be sent instead of asking for a new one. The
 * server refuses a token that a replaced key got, so the token has to come
 * from the key in the file now. The key also has to be fresh, with no renewal
 * left unfinished, so that the next request renews a key that is due.
 */
export function storedTokenUsable(
  token: { expiresAt: number; keyId?: string } | null,
  key: ServiceKey,
  now: number,
  skewSeconds: number,
): boolean {
  return (
    token !== null &&
    token.keyId === key.privateJwk.x &&
    token.expiresAt - skewSeconds > Math.floor(now / 1000) &&
    key.nextPrivateJwk === undefined &&
    now - key.renewedAt < RENEW_AFTER_MS
  );
}

/** An access token for the key's account, renewing the key first when it is due. */
export async function serviceToken(
  path: string,
  deps: Dependencies,
): Promise<{ accessToken: string; expiresIn: number; key: ServiceKey }> {
  let key = await readServiceKey(path);
  if (!key) throw new ServiceKeyError(`No service key at ${path}.`);
  if (key.nextPrivateJwk || deps.now() - key.renewedAt >= RENEW_AFTER_MS) {
    key = await renew(path, { force: false }, deps);
  }
  let token = await requestToken(key, key.privateJwk, deps);
  if (!token) {
    // Another process may have renewed since the file was read. `renew` reads
    // it again under the lock and finishes a renewal that did not complete.
    const latest = await renew(path, { force: false }, deps);
    if (latest.privateJwk.x !== key.privateJwk.x) {
      key = latest;
      token = await requestToken(key, key.privateJwk, deps);
    }
  }
  if (!token) throw new ServiceKeyRevokedError(key.origin, deps.command);
  return { ...token, key };
}
