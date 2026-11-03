import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "../auth/middleware.ts";
import type { VardaOutbox } from "../storage/varda-outbox.ts";

/** A pull_request event is a few tens of KiB; GitHub would send up to 25 MB. */
export const WEBHOOK_MAX_BYTES = 1024 * 1024;

export type VardaOptions = {
  /** The user id of Varda's account. */
  account: string;
  /** The GitHub App's webhook secret. Without it, the GitHub endpoint does not exist. */
  webhookSecret?: string;
  outbox: VardaOutbox;
};

/** The Varda integration's routes, mounted only when it is on. docs/varda-integration.md. */
export function vardaRoutes(options: VardaOptions) {
  const routes = new Hono<AppEnv>();
  const secret = options.webhookSecret;

  // GitHub's signature is the only authentication. GitHub sends no cookie, so
  // the same-origin check on /api lets the request through.
  if (secret !== undefined) {
    routes.post(
      "/github",
      bodyLimit({
        maxSize: WEBHOOK_MAX_BYTES,
        onError: (c) =>
          c.json({ error: { code: "FILE_TOO_LARGE", message: "The event is too large." } }, 413),
      }),
      async (c) => {
        const body = Buffer.from(await c.req.arrayBuffer());
        if (!signedBy(secret, body, c.req.header("X-Hub-Signature-256"))) {
          return c.json(
            { error: { code: "UNAUTHENTICATED", message: "The signature does not match." } },
            401,
          );
        }
        // ping and every other event are acknowledged and dropped.
        if (c.req.header("X-GitHub-Event") !== "pull_request") return c.body(null, 204);
        const data = pullRequestRow(body);
        if (data === null) {
          console.error(
            "Varda integration: a signed pull_request event without the expected fields",
          );
          return c.body(null, 204);
        }
        const id = options.outbox.insert(data, c.req.header("X-GitHub-Delivery"));
        if (id !== null) options.outbox.announce({ id, data });
        return c.body(null, 204);
      },
    );
  }

  return routes;
}

function signedBy(secret: string, body: Buffer, header: string | undefined): boolean {
  if (header === undefined) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The row data for a pull_request event, or null when a field is missing. */
function pullRequestRow(body: Buffer): string | null {
  let event: unknown;
  try {
    event = JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
  if (typeof event !== "object" || event === null) return null;
  const payload = event as {
    action?: unknown;
    repository?: { full_name?: unknown };
    pull_request?: { number?: unknown; head?: { sha?: unknown } };
  };
  const action = payload.action;
  const repo = payload.repository?.full_name;
  const pr = payload.pull_request?.number;
  const head = payload.pull_request?.head?.sha;
  if (
    typeof action !== "string" ||
    typeof repo !== "string" ||
    typeof pr !== "number" ||
    typeof head !== "string"
  ) {
    return null;
  }
  return JSON.stringify({
    type: "github",
    event: "pull_request",
    action,
    repo,
    pr,
    head,
    at: new Date().toISOString(),
  });
}
