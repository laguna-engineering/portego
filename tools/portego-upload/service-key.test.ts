import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLiveTestServer, type LiveTestServer } from "../../src/server/testing.ts";
import {
  type Dependencies,
  enroll,
  RENEW_AFTER_MS,
  readServiceKey,
  renew,
  type ServiceKey,
  ServiceKeyRevokedError,
  serviceToken,
  storedTokenUsable,
} from "./service-key.ts";

const ADMIN = {
  sub: "google-admin",
  email: "admin@acme.example",
  email_verified: true,
  name: "An Admin",
};

let server: LiveTestServer;
let adminCookie: string;
let directory: string;

beforeAll(async () => {
  server = await createLiveTestServer({ serviceAccounts: true, admins: [ADMIN.email] });
  adminCookie = await server.signIn(ADMIN);
  directory = await mkdtemp(join(tmpdir(), "service-key-"));
});

afterAll(async () => {
  server.stop();
  await rm(directory, { recursive: true, force: true });
});

function dependencies(overrides: Partial<Dependencies> = {}): Dependencies {
  return {
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    command: "portego-upload",
    log: () => {},
    ...overrides,
  };
}

/** Enrolls a key, approving it as soon as the server has the request. */
async function enrolled(path: string): Promise<void> {
  await enroll(
    { origin: server.origin, name: "CLI agent", path },
    dependencies({
      fetch: async (url, init) => {
        const response = await fetch(url, init);
        if (url.endsWith("/api/service-accounts/enrollments") && init?.method === "POST") {
          const { id } = (await response.clone().json()) as { id: string };
          await fetch(`${server.origin}/api/service-accounts/enrollments/${id}/approval`, {
            method: "POST",
            headers: {
              cookie: adminCookie,
              origin: server.origin,
              "content-type": "application/json",
            },
            body: JSON.stringify({ kind: "member" }),
          });
        }
        return response;
      },
    }),
  );
}

function listTools(token: string): Promise<Response> {
  return fetch(`${server.origin}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

/** Moves the key's last renewal back, so the next use renews it. */
async function age(path: string): Promise<void> {
  const key = await readServiceKey(path);
  if (!key) throw new Error("no key");
  await writeFile(path, JSON.stringify({ ...key, renewedAt: key.renewedAt - RENEW_AFTER_MS }));
}

describe("service keys", () => {
  test("an enrolled key signs the agent in without a browser", async () => {
    const path = join(directory, "enrolled", "service-key.json");
    await enrolled(path);

    const key = await readServiceKey(path);
    expect(key?.origin).toBe(server.origin);
    expect(key?.privateJwk.d).toBeString();
    // The private key is readable by its owner only.
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, "enrolled"))).mode & 0o777).toBe(0o700);

    const { accessToken } = await serviceToken(path, dependencies());
    expect((await listTools(accessToken)).status).toBe(200);
  });

  test("renews a key older than a day before asking for a token", async () => {
    const path = join(directory, "aged", "service-key.json");
    await enrolled(path);
    const before = await readServiceKey(path);
    await age(path);

    const { accessToken } = await serviceToken(path, dependencies());
    const after = await readServiceKey(path);
    expect(after?.privateJwk.d).not.toBe(before?.privateJwk.d);
    expect((await listTools(accessToken)).status).toBe(200);
  });

  // Several agent processes share one key file. Without the lock, the second
  // renewal would sign with the key the first just replaced.
  test("two callers due to renew at once end with one valid key and no error", async () => {
    const path = join(directory, "concurrent", "service-key.json");
    await enrolled(path);
    await age(path);

    const results = await Promise.all([
      serviceToken(path, dependencies()),
      serviceToken(path, dependencies()),
    ]);
    for (const { accessToken } of results) {
      expect((await listTools(accessToken)).status).toBe(200);
    }
    const key = await readServiceKey(path);
    expect(Date.now() - (key?.renewedAt ?? 0)).toBeLessThan(RENEW_AFTER_MS);
  });

  test("two processes renewing at the same time both succeed", async () => {
    const path = join(directory, "processes", "service-key.json");
    await enrolled(path);

    const run = () =>
      Bun.spawn(["bun", "run", join(import.meta.dir, "index.ts"), "service-key", "renew"], {
        env: {
          PATH: process.env.PATH ?? "",
          PORTEGO_SERVICE_KEY: path,
          PORTEGO_CREDENTIALS: join(directory, "processes", "credentials.json"),
          PORTEGO_ORIGIN: server.origin,
        },
        stderr: "pipe",
      });
    const processes = [run(), run()];
    const codes = await Promise.all(processes.map((child) => child.exited));
    const errors = await Promise.all(processes.map((child) => new Response(child.stderr).text()));
    expect(codes, errors.join("\n")).toEqual([0, 0]);
    for (const output of errors) expect(output).not.toContain("refused");

    const { accessToken } = await serviceToken(path, dependencies());
    expect((await listTools(accessToken)).status).toBe(200);
  });

  // The token is filed under PORTEGO_ORIGIN, so enrolling with another
  // deployment would later send that deployment's token to the wrong one.
  test("refuses to enroll with a deployment other than PORTEGO_ORIGIN", async () => {
    const child = Bun.spawn(
      [
        "bun",
        "run",
        join(import.meta.dir, "index.ts"),
        "service-key",
        "enroll",
        server.origin,
        "--name",
        "Agent",
      ],
      {
        env: {
          PATH: process.env.PATH ?? "",
          PORTEGO_SERVICE_KEY: join(directory, "mismatch", "service-key.json"),
          PORTEGO_CREDENTIALS: join(directory, "mismatch", "credentials.json"),
          PORTEGO_ORIGIN: "https://other.acme.example",
        },
        stderr: "pipe",
      },
    );
    expect(await child.exited).toBe(1);
    expect(await new Response(child.stderr).text()).toContain(
      "PORTEGO_ORIGIN names https://other.acme.example",
    );
    await expect(readFile(join(directory, "mismatch", "credentials.json"))).rejects.toThrow();
  });

  // A copied key works until the real agent renews. Then it must stop, and say
  // so once instead of retrying.
  test("a copy of a key that was renewed elsewhere is reported as replaced", async () => {
    const path = join(directory, "original", "service-key.json");
    await enrolled(path);
    const copy = join(directory, "copy.json");
    await copyFile(path, copy);
    await age(path);
    await serviceToken(path, dependencies());

    let requests = 0;
    const counting = dependencies({
      fetch: (url, init) => {
        requests += 1;
        return fetch(url, init);
      },
    });
    await expect(serviceToken(copy, counting)).rejects.toBeInstanceOf(ServiceKeyRevokedError);
    expect(requests).toBe(1);
    await age(copy);
    await expect(serviceToken(copy, counting)).rejects.toBeInstanceOf(ServiceKeyRevokedError);
  });

  test("a disabled account is reported as revoked", async () => {
    const path = join(directory, "disabled", "service-key.json");
    await enrolled(path);
    const key = await readServiceKey(path);
    const account = server.database
      .query("select userId from serviceAccounts where clientId = ?")
      .get(key?.clientId ?? "") as { userId: string };
    await fetch(`${server.origin}/api/service-accounts/${account.userId}/disable`, {
      method: "POST",
      headers: { cookie: adminCookie, origin: server.origin },
    });

    const error = await serviceToken(path, dependencies()).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ServiceKeyRevokedError);
    expect((error as Error).message).toContain("service-key enroll");
  });

  test("leaves no lock file behind", async () => {
    const path = join(directory, "lock", "service-key.json");
    await enrolled(path);
    await age(path);
    await serviceToken(path, dependencies());
    await expect(readFile(`${path}.lock`)).rejects.toThrow();
  });

  // The server can take the new key and the answer can still be lost. The
  // agent must not then be locked out until an admin enrolls it again.
  test("recovers when a renewal reached the server but its answer did not", async () => {
    const path = join(directory, "lost", "service-key.json");
    await enrolled(path);
    const lose = dependencies({
      fetch: async (url, init) => {
        const response = await fetch(url, init);
        if (url.endsWith("/api/service-accounts/renew")) throw new Error("connection reset");
        return response;
      },
    });
    await expect(renew(path, { force: true }, lose)).rejects.toThrow("connection reset");
    const pending = await readServiceKey(path);
    expect(pending?.nextPrivateJwk).toBeDefined();

    const { accessToken, key } = await serviceToken(path, dependencies());
    expect((await listTools(accessToken)).status).toBe(200);
    expect(key.privateJwk.x).toBe(pending?.nextPrivateJwk?.x);
    expect((await readServiceKey(path))?.nextPrivateJwk).toBeUndefined();
  });

  test("renews again after a renewal whose answer was lost", async () => {
    const path = join(directory, "lost-renew", "service-key.json");
    await enrolled(path);
    const lose = dependencies({
      fetch: async (url, init) => {
        const response = await fetch(url, init);
        if (url.endsWith("/api/service-accounts/renew")) throw new Error("connection reset");
        return response;
      },
    });
    await expect(renew(path, { force: true }, lose)).rejects.toThrow("connection reset");

    await renew(path, { force: true }, dependencies());
    const { accessToken } = await serviceToken(path, dependencies());
    expect((await listTools(accessToken)).status).toBe(200);
  });
});

describe("the stored token", () => {
  const key: ServiceKey = {
    origin: "https://share.acme.example",
    clientId: "client",
    privateJwk: { kty: "OKP", crv: "Ed25519", x: "current", d: "secret" },
    renewedAt: Date.parse("2026-11-10T12:00:00Z"),
  };
  const now = key.renewedAt + 60 * 1000;
  const token = { expiresAt: Math.floor(now / 1000) + 3000, keyId: "current" };

  test("is reused while it came from the key in the file and has time left", () => {
    expect(storedTokenUsable(token, key, now, 60)).toBe(true);
  });

  // The server refuses a token that a replaced key got.
  test("is not reused once the key changed, whatever the clocks say", () => {
    expect(storedTokenUsable({ ...token, keyId: "replaced" }, key, now, 60)).toBe(false);
    expect(storedTokenUsable({ expiresAt: token.expiresAt }, key, now, 60)).toBe(false);
  });

  test("is not reused when it is about to expire", () => {
    expect(
      storedTokenUsable({ ...token, expiresAt: Math.floor(now / 1000) + 30 }, key, now, 60),
    ).toBe(false);
  });

  // Otherwise a busy agent would never renew its key while a token was stored.
  test("is not reused when the key is due to renew", () => {
    expect(storedTokenUsable(token, key, key.renewedAt + RENEW_AFTER_MS, 60)).toBe(false);
  });
});
