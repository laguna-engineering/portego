import { Hono } from "hono";
import { ServiceError } from "../artifacts/errors.ts";
import { type AppEnv, currentUser, requireUser } from "../auth/middleware.ts";
import type { OrganizationService } from "./service.ts";

export function organizationRoutes(service: OrganizationService): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get("/folders", requireUser, (c) => c.json({ folders: service.folders() }));

  routes.post("/folders", requireUser, async (c) => {
    const body = await readJson(c.req.raw);
    const folder = service.createFolder({
      name: body.name,
      ...(Object.hasOwn(body, "parentId") ? { parentId: body.parentId } : {}),
      actorId: currentUser(c).id,
    });
    return c.json({ folder }, 201);
  });

  routes.patch("/folders/:id", requireUser, async (c) => {
    const body = await readJson(c.req.raw);
    const folder = service.updateFolder(c.req.param("id"), {
      ...(Object.hasOwn(body, "name") ? { name: body.name } : {}),
      ...(Object.hasOwn(body, "parentId") ? { parentId: body.parentId } : {}),
      actorId: currentUser(c).id,
    });
    return c.json({ folder });
  });

  routes.delete("/folders/:id", requireUser, (c) => {
    service.deleteFolder(c.req.param("id"));
    return c.body(null, 204);
  });

  routes.get("/tags", requireUser, (c) => c.json({ tags: service.tags() }));

  routes.post("/tags", requireUser, async (c) => {
    const body = await readJson(c.req.raw);
    const tag = service.createTag({ name: body.name, actorId: currentUser(c).id });
    return c.json({ tag }, 201);
  });

  routes.patch("/tags/:id", requireUser, async (c) => {
    const body = await readJson(c.req.raw);
    const tag = service.updateTag(c.req.param("id"), {
      name: body.name,
      actorId: currentUser(c).id,
    });
    return c.json({ tag });
  });

  routes.delete("/tags/:id", requireUser, (c) => {
    service.deleteTag(c.req.param("id"));
    return c.body(null, 204);
  });

  return routes;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    if (!body || typeof body !== "object") throw new Error("not an object");
    return body as Record<string, unknown>;
  } catch {
    throw new ServiceError("INVALID_INPUT", "Send a JSON object.");
  }
}
