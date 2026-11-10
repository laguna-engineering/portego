import { Hono } from "hono";
import { ServiceError } from "../artifacts/errors.ts";
import { requireAdmin } from "../auth/admins.ts";
import { type AppEnv, currentUser } from "../auth/middleware.ts";
import type { ServiceAccount } from "../storage/service-accounts.ts";
import type { ServiceAccountService } from "./service.ts";

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    if (typeof body === "object" && body !== null && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
  } catch {
    // Reported below with the same message as a body that is not an object.
  }
  throw new ServiceError("INVALID_INPUT", "The request body must be a JSON object.");
}

function bearer(header: string | undefined): string | null {
  const match = header?.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? null;
}

const iso = (ms: number) => new Date(ms).toISOString();

function toJson(account: ServiceAccount) {
  return {
    id: account.userId,
    clientId: account.clientId,
    name: account.name,
    kind: account.kind,
    approvedBy: { id: account.approvedBy, name: account.approvedByName },
    createdAt: iso(account.createdAt),
    renewedAt: iso(account.renewedAt),
    expiresAt: iso(account.expiresAt),
    disabledAt: account.disabledAt === null ? null : iso(account.disabledAt),
  };
}

/**
 * Enrollment, polling, and renewal are called by an agent with no session:
 * each one is checked by a signature from the agent's key instead. Everything
 * else is for admins.
 */
export function serviceAccountRoutes(
  service: ServiceAccountService,
  admins: readonly string[],
): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const admin = requireAdmin(admins);

  routes.post("/enrollments", async (c) => {
    const body = await readJson(c.req.raw);
    const enrollment = await service.enroll({ name: body.name, publicJwk: body.publicJwk });
    return c.json({ ...enrollment, expiresAt: iso(enrollment.expiresAt) }, 201);
  });

  routes.get("/enrollments/:id", async (c) => {
    const result = await service.poll(c.req.param("id"), bearer(c.req.header("authorization")));
    return c.json(result);
  });

  // The assertion in the body is the only credential this accepts. An access
  // token lives for an hour and must not be able to replace the key.
  routes.post("/renew", async (c) => {
    const body = await readJson(c.req.raw);
    const renewed = await service.renew({
      clientId: body.clientId,
      publicJwk: body.publicJwk,
      assertion: body.assertion,
    });
    return c.json({ renewedAt: iso(renewed.renewedAt), expiresAt: iso(renewed.expiresAt) });
  });

  routes.get("/", admin, (c) => c.json({ accounts: service.list().map(toJson) }));

  routes.get("/enrollments/:id/approval", admin, async (c) => {
    const enrollment = await service.review(c.req.param("id"));
    return c.json({
      enrollment: {
        ...enrollment,
        createdAt: iso(enrollment.createdAt),
        expiresAt: iso(enrollment.expiresAt),
      },
    });
  });

  routes.post("/enrollments/:id/approval", admin, async (c) => {
    const body = await readJson(c.req.raw);
    const account = service.approve(
      c.req.param("id"),
      { kind: body.kind, accountId: body.accountId },
      currentUser(c).id,
    );
    return c.json({ account: toJson(account) });
  });

  routes.post("/:id/disable", admin, (c) =>
    c.json({ account: toJson(service.disable(c.req.param("id"))) }),
  );

  return routes;
}
