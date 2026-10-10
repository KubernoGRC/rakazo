import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AdapterContext, ConnectorEvent, ConnectorProvider } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DeploymentMcpConnector,
  deploymentConnectorConfigFromEnv,
  deploymentConnectorProviders,
  deploymentDisabledBuiltinTools,
} from "./deployment-connectors.js";

const ENDPOINT = "https://mcp.private.example.test/mcp";
const TOKEN = "deployment-token-value";

function provider(id: string): ConnectorProvider {
  return {
    describe: () => ({
      id,
      contractVersion: "1",
      adapterVersion: "0",
      capabilities: { discover: true, oauth: false, secretsBrokered: false },
    }),
    discoverTools: async () => [],
    execute: async function* () {},
  };
}

function context(extra: Partial<AdapterContext> = {}): AdapterContext {
  return {
    operationId: "op",
    traceId: "trace",
    spaceId: "space-1",
    userId: "user-1",
    signal: new AbortController().signal,
    ...extra,
  };
}

/** A real MCP server behind an injected fetch, so no socket or DNS is used. */
function mcpServer() {
  const seen: { authorization: string | null; meta: unknown[] } = {
    authorization: null,
    meta: [],
  };
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.delete("host");
    seen.authorization = headers.get("authorization");
    const server = new McpServer({ name: "deployment", version: "1.0.0" });
    server.registerTool(
      "echo",
      {
        description: "Echo text",
        inputSchema: { text: z.string() },
        annotations: { readOnlyHint: true },
      },
      async ({ text }, extra) => {
        seen.meta.push(extra._meta);
        return { content: [{ type: "text", text: `${text} ${TOKEN}` }] };
      },
    );
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(new Request(String(input), { ...init, headers }));
  };
  return { fetch: fetch as typeof globalThis.fetch, seen };
}

const privateResolver = async () => [{ address: "10.0.4.20", family: 4 as const }];

async function collect(events: AsyncIterable<ConnectorEvent>): Promise<ConnectorEvent[]> {
  const out: ConnectorEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("deploymentConnectorConfigFromEnv", () => {
  it("is off by default", () => {
    expect(deploymentConnectorConfigFromEnv({})).toEqual({ lockdown: false });
  });

  it("reads the lock-down flag and the deployment MCP server", () => {
    expect(
      deploymentConnectorConfigFromEnv({
        CONNECTOR_LOCKDOWN: "true",
        DEPLOYMENT_MCP_URL: ENDPOINT,
        DEPLOYMENT_MCP_TOKEN: TOKEN,
        DEPLOYMENT_MCP_PRIVATE_ENDPOINT: "true",
      }),
    ).toEqual({
      lockdown: true,
      mcp: { endpoint: ENDPOINT, token: TOKEN, privateEndpoint: true },
    });
  });

  it.each([
    [{ DEPLOYMENT_MCP_URL: "http://mcp.example.test/mcp" }, /HTTPS/],
    [{ DEPLOYMENT_MCP_URL: "https://user:pass@mcp.example.test/mcp" }, /HTTPS/],
    [{ DEPLOYMENT_MCP_URL: "not a url" }, /HTTPS/],
    [{ DEPLOYMENT_MCP_TOKEN: TOKEN }, /need DEPLOYMENT_MCP_URL/],
    [{ DEPLOYMENT_MCP_PRIVATE_ENDPOINT: "true" }, /need DEPLOYMENT_MCP_URL/],
    [
      { DEPLOYMENT_MCP_URL: "https://10.0.4.20/mcp", DEPLOYMENT_MCP_PRIVATE_ENDPOINT: "true" },
      /DNS hostname/,
    ],
  ])("rejects %o", (env, message) => {
    expect(() => deploymentConnectorConfigFromEnv(env)).toThrow(message);
  });
});

describe("deploymentConnectorProviders", () => {
  const built = () => [provider("installed"), provider("composio"), provider("mcp")];
  const ids = (providers: ConnectorProvider[]) => providers.map((p) => p.describe().id);

  it("keeps every provider when not locked down", () => {
    expect(ids(deploymentConnectorProviders({ lockdown: false }, built()))).toEqual([
      "installed",
      "composio",
      "mcp",
    ]);
  });

  it("drops user-managed MCP servers and installs when locked down", () => {
    expect(ids(deploymentConnectorProviders({ lockdown: true }, built()))).toEqual(["composio"]);
  });

  it("adds the deployment MCP server", () => {
    expect(
      ids(
        deploymentConnectorProviders(
          { lockdown: true, mcp: { endpoint: ENDPOINT, privateEndpoint: false } },
          built(),
        ),
      ),
    ).toEqual(["composio", "deployment"]);
  });

  it("removes add_mcp_server only when locked down", () => {
    expect(deploymentDisabledBuiltinTools({ lockdown: true })).toEqual(["add_mcp_server"]);
    expect(deploymentDisabledBuiltinTools({ lockdown: false })).toEqual([]);
  });
});

describe("DeploymentMcpConnector", () => {
  it("discovers and calls tools over the pinned private endpoint", async () => {
    const server = mcpServer();
    const connector = new DeploymentMcpConnector(
      { endpoint: ENDPOINT, token: TOKEN, privateEndpoint: true },
      { fetch: server.fetch, resolveHostname: privateResolver },
    );
    const tools = await connector.discoverTools(context());
    expect(tools).toEqual([expect.objectContaining({ name: "echo", readOnly: true })]);
    expect(server.seen.authorization).toBe(`Bearer ${TOKEN}`);

    const events = await collect(
      connector.execute(
        { tool: "echo", args: { text: "hi" }, executionId: "call-1" },
        context({ runId: "run-1", botId: "bot-1" }),
      ),
    );
    expect(server.seen.meta).toEqual([{ runId: "run-1", botId: "bot-1" }]);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("result");
    expect(JSON.stringify(events[0])).not.toContain(TOKEN);
  });

  it("sends no _meta when the call has no run or bot", async () => {
    const server = mcpServer();
    const connector = new DeploymentMcpConnector(
      { endpoint: ENDPOINT, privateEndpoint: true },
      { fetch: server.fetch, resolveHostname: privateResolver },
    );
    await collect(
      connector.execute({ tool: "echo", args: { text: "hi" }, executionId: "call-1" }, context()),
    );
    expect(server.seen.meta).toEqual([undefined]);
  });

  it("refuses a private endpoint that was not pinned", async () => {
    const server = mcpServer();
    const connector = new DeploymentMcpConnector(
      { endpoint: ENDPOINT, privateEndpoint: false },
      { fetch: server.fetch, resolveHostname: privateResolver },
    );
    await expect(connector.discoverTools(context())).rejects.toThrow(/private address/);
    const events = await collect(
      connector.execute({ tool: "echo", args: {}, executionId: "call-1" }, context()),
    );
    expect(events).toEqual([{ type: "error", message: expect.stringMatching(/private address/) }]);
  });
});
