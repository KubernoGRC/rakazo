import { describe, expect, it } from "vitest";
import { assertMcpRemoteEndpoint } from "./mcp-servers.js";
import type { RouterDeps } from "./router.js";

const deps = (mcpPrivateEndpointHosts?: readonly string[]) =>
  ({
    env: { mcpPrivateEndpointHosts } as RouterDeps["env"],
    remoteConnectors: {
      resolveHostname: async () => [{ address: "10.0.4.20", family: 4 as const }],
    },
  }) satisfies Pick<RouterDeps, "env" | "remoteConnectors">;

describe("saving a remote MCP server on a pinned private host", () => {
  it("accepts a host MCP_PRIVATE_ENDPOINT_HOSTS lists", async () => {
    await expect(
      assertMcpRemoteEndpoint("https://runner.example.test/mcp", deps(["runner.example.test"])),
    ).resolves.toBeUndefined();
  });

  it("refuses it when the host isn't listed", async () => {
    await expect(
      assertMcpRemoteEndpoint("https://runner.example.test/mcp", deps()),
    ).rejects.toThrow(/private address/);
    await expect(
      assertMcpRemoteEndpoint("https://other.example.test/mcp", deps(["runner.example.test"])),
    ).rejects.toThrow(/private address/);
  });
});
