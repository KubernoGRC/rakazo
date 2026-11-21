import { isIP } from "node:net";

/** At least two labels, and a top label that starts with a letter, so an IP literal
 * (every label digits) or a single label searched through resolv.conf is refused. */
const DNS_NAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * `MCP_PRIVATE_ENDPOINT_HOSTS`: comma-separated exact DNS names that user-configured
 * remote MCP servers may reach on private addresses. Each one gets the deployment
 * connector's pinned-host rules (`privateEndpointHost` in remote-mcp.ts): HTTPS only,
 * and every resolved address RFC 1918 or fd00::/8, never metadata, link-local or
 * loopback. Unlike `MCP_ALLOW_PRIVATE_ENDPOINT`, every other private host stays refused.
 *
 * An entry that isn't a plain DNS name throws, so a typo fails at startup rather than
 * pinning nothing.
 */
export function mcpPrivateEndpointHostsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const hosts = (env.MCP_PRIVATE_ENDPOINT_HOSTS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase().replace(/\.$/, ""))
    .filter(Boolean);
  for (const host of hosts) {
    if (isIP(host) !== 0 || !DNS_NAME.test(host)) {
      throw new Error(`MCP_PRIVATE_ENDPOINT_HOSTS entry is not a DNS hostname: ${host}`);
    }
  }
  return [...new Set(hosts)];
}
