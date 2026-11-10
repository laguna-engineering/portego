import { Hono } from "hono";
import { readJson } from "../artifacts/routes.ts";
import { requireAdmin } from "../auth/admins.ts";
import { type AppEnv, currentUser } from "../auth/middleware.ts";
import type { Invitation, Team } from "../storage/teams.ts";
import type { TeamService } from "./service.ts";

const iso = (ms: number) => new Date(ms).toISOString();

function teamJson(team: Team) {
  return { ...team, createdAt: iso(team.createdAt) };
}

function invitationJson(invitation: Invitation) {
  return {
    ...invitation,
    createdAt: iso(invitation.createdAt),
    expiresAt: iso(invitation.expiresAt),
    acceptedAt: invitation.acceptedAt === null ? null : iso(invitation.acceptedAt),
  };
}

/**
 * Teams and the folders they restrict. Admins only, and only with TEAMS=true:
 * otherwise these routes do not exist. No MCP tool reaches them, because an
 * agent should never manage access.
 */
export function teamRoutes(service: TeamService, admins: readonly string[]): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use("*", requireAdmin(admins));

  routes.get("/", (c) => {
    const { teams, people, folders } = service.overview();
    return c.json({ teams: teams.map(teamJson), people, folders });
  });

  routes.post("/", async (c) => {
    const body = await readJson(c);
    const team = service.createTeam({ name: body.name }, currentUser(c).id);
    return c.json({ team: teamJson(team) }, 201);
  });

  routes.patch("/:id", async (c) => {
    const body = await readJson(c);
    return c.json({ team: teamJson(service.renameTeam(c.req.param("id"), { name: body.name })) });
  });

  routes.delete("/:id", (c) => {
    service.deleteTeam(c.req.param("id"));
    return c.body(null, 204);
  });

  routes.put("/:id/members/:userId", (c) =>
    c.json({
      team: teamJson(
        service.addMember(c.req.param("id"), c.req.param("userId"), currentUser(c).id),
      ),
    }),
  );

  routes.delete("/:id/members/:userId", (c) =>
    c.json({ team: teamJson(service.removeMember(c.req.param("id"), c.req.param("userId"))) }),
  );

  routes.put("/:id/folders/:folderId", (c) =>
    c.json({
      team: teamJson(
        service.addFolder(c.req.param("id"), c.req.param("folderId"), currentUser(c).id),
      ),
    }),
  );

  routes.delete("/:id/folders/:folderId", (c) =>
    c.json({ team: teamJson(service.removeFolder(c.req.param("id"), c.req.param("folderId"))) }),
  );

  return routes;
}

/** Invitations for guests. Admins only, and only with TEAMS=true. */
export function invitationRoutes(service: TeamService, admins: readonly string[]): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use("*", requireAdmin(admins));

  routes.get("/", (c) => c.json({ invitations: service.invitations().map(invitationJson) }));

  routes.post("/", async (c) => {
    const body = await readJson(c);
    const invitation = service.invite(
      { email: body.email, teamIds: body.teamIds },
      currentUser(c).id,
    );
    return c.json({ invitation: invitationJson(invitation) }, 201);
  });

  routes.delete("/:id", (c) => {
    service.revokeInvitation(c.req.param("id"));
    return c.body(null, 204);
  });

  return routes;
}
