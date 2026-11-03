import type { PrismaClient } from "@rakazo/db";
import type { McpOAuthBroker } from "./mcp-oauth.js";

/**
 * Fork patch: the run owner's own forge token, for the computer cloud agent
 * (docs/fork-computer-coding-agent.md). It is the OAuth token the user's own
 * MCP connection already holds for the forge's authorization server, so no new
 * client or grant exists. It is used in the worker only and never written into
 * a computer. The broker refreshes an expired token under its usual lock.
 */
export function mcpForgeTokenResolver(deps: {
  prisma: Pick<PrismaClient, "mcpServer">;
  broker: Pick<McpOAuthBroker, "providerFor">;
  /** The forge's OAuth authorization server, e.g. https://github.com/login/oauth. */
  issuer: string;
}) {
  const issuer = normalizeIssuer(deps.issuer);
  return async (userId: string, spaceId: string): Promise<string | undefined> => {
    const servers = await deps.prisma.mcpServer.findMany({
      where: { userId, spaceId, enabled: true, secretId: { not: null } },
      select: { id: true, endpoint: true, secretId: true },
      orderBy: { createdAt: "asc" },
    });
    for (const server of servers) {
      const provider = await deps.broker
        .providerFor(server, { userId, spaceId })
        .catch(() => undefined);
      const discovered = provider?.discoveryState()?.authorizationServerUrl;
      if (!provider || !discovered || normalizeIssuer(String(discovered)) !== issuer) continue;
      const token = (await provider.tokens().catch(() => undefined))?.access_token;
      if (token) return token;
    }
    return undefined;
  };
}

function normalizeIssuer(value: string) {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}
