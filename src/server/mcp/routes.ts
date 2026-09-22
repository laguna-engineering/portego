import { requireMcpAuth } from "@better-auth/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { JWTPayload } from "jose";
import type { ArtifactService } from "../artifacts/service.ts";
import type { UploadTicketIssuer } from "../artifacts/tickets.ts";
import type { Auth } from "../auth/auth.ts";
import { MCP_SCOPES } from "../auth/config.ts";
import type { OrganizationService } from "../organization/service.ts";
import { registerArtifactTools } from "./tools.ts";

export const SERVER_NAME = "portego";
export const SERVER_VERSION = "0.1.0";

/** Resolves an access token's subject to an application user, or refuses it. */
export type ResolvePrincipal = (claims: JWTPayload) => Promise<{ userId: string } | null>;

export type McpHandlerOptions = {
  auth: Auth;
  service: ArtifactService;
  organization: OrganizationService;
  /** The exact MCP URL. Tokens carry it as their audience. */
  resource: string;
  webUrl: (artifactId: string) => string;
  /** Mints the capability a client uses to upload a file outside this transport. */
  issueUploadTicket: UploadTicketIssuer;
  resolvePrincipal: ResolvePrincipal;
  /** Hosts and origins this endpoint answers for. Anything else is refused. */
  allowedHosts: string[];
  allowedOrigins: string[];
};

function jsonRpcError(status: number, message: string): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message }, id: null }),
    { status, headers: { "content-type": "application/json" } },
  );
}

function scopesOf(claims: JWTPayload): Set<string> {
  const scope = claims.scope;
  return new Set(typeof scope === "string" ? scope.split(" ").filter(Boolean) : []);
}

/**
 * The MCP endpoint. Every request carries an access token this deployment
 * issued, bound to this exact URL. The token's subject decides who the caller
 * is; a user id in tool arguments is never read.
 */
export function createMcpHandler(
  options: McpHandlerOptions,
): (request: Request) => Promise<Response> {
  return requireMcpAuth(
    options.auth,
    async (request, claims) => {
      // Stateless means no server-initiated stream and no session to close, so
      // POST is the only method with anything to do. A GET would otherwise
      // hold an event stream open for a session that does not exist.
      if (request.method !== "POST") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32601, message: "This endpoint is stateless. Use POST." },
            id: null,
          }),
          { status: 405, headers: { "content-type": "application/json", allow: "POST" } },
        );
      }

      const principal = await options.resolvePrincipal(claims);
      if (!principal) {
        return jsonRpcError(403, "This account is not allowed to use this service.");
      }

      // Stateless: one server and one transport per request, so nothing is
      // carried between callers.
      const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
      registerArtifactTools(server, {
        service: options.service,
        organization: options.organization,
        userId: principal.userId,
        webUrl: options.webUrl,
        issueUploadTicket: options.issueUploadTicket,
        scopes: scopesOf(claims),
      });

      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
        allowedHosts: options.allowedHosts,
        allowedOrigins: options.allowedOrigins,
        enableDnsRebindingProtection: true,
      });

      await server.connect(transport);
      const response = await transport.handleRequest(request);
      if (!response.headers.get("content-type")?.includes("text/event-stream")) {
        await server.close();
      }
      return response;
    },
    {
      resource: options.resource,
      requiredScopes: ["artifacts:read"],
      // The scopes a client should ask for. `requiredScopes` above is the
      // minimum a token needs to reach this endpoint, so a client that read
      // it as the hint would never request write access.
      challengeScopes: [...MCP_SCOPES],
    },
  );
}
