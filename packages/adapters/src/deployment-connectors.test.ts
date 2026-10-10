import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AdapterContext, ConnectorEvent, ConnectorProvider } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createConnectorStack } from "./composio-connector.js";
import {
  DeploymentMcpConnector,
  deploymentConnectorConfigFromEnv,
  deploymentConnectorProviders,
} from "./deployment-connectors.js";

const ENDPOINT = "https://mcp.private.example.test/mcp";
const TOKEN = "deployment-token-value";

function provider(id: string, toolNames: string[] = []) {
  const calls: string[] = [];
  const result: ConnectorProvider & { calls: string[] } = {
    calls,
    describe: () => ({
      id,
      contractVersion: "1",
      adapterVersion: "0",
      capabilities: { discover: true, oauth: false, secretsBrokered: false },
    }),
    discoverTools: async () =>
      toolNames.map((name) => ({ name, description: name, inputSchema: { type: "object" } })),
    execute: async function* (call) {
      calls.push(call.tool);
      yield { type: "result" as const, data: null };
    },
  };
  return result;
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
    expect(deploymentConnectorConfigFromEnv({})).toEqual({});
  });

  it("reads the deployment MCP server", () => {
    expect(
      deploymentConnectorConfigFromEnv({
        DEPLOYMENT_MCP_URL: ENDPOINT,
        DEPLOYMENT_MCP_TOKEN: TOKEN,
        DEPLOYMENT_MCP_PRIVATE_ENDPOINT: "true",
      }),
    ).toEqual({
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
  const ids = (providers: ConnectorProvider[]) => providers.map((p) => p.describe().id);
  const userOwned = () => [provider("installed", ["echo"]), provider("mcp", ["lookup"])];

  it("leaves the providers alone when no deployment server is configured", () => {
    expect(ids(deploymentConnectorProviders({}, userOwned()))).toEqual(["installed", "mcp"]);
  });

  it("keeps every user-owned source and puts the deployment server first", () => {
    expect(
      ids(
        deploymentConnectorProviders(
          { mcp: { endpoint: ENDPOINT, privateEndpoint: true } },
          userOwned(),
        ),
      ),
    ).toEqual(["deployment", "installed", "mcp"]);
  });

  it("keeps the deployment tool's name when a user-added tool collides with it", async () => {
    const server = mcpServer();
    const user = provider("installed", ["echo"]);
    const { connector } = createConnectorStack(
      false,
      undefined,
      deploymentConnectorProviders({ mcp: { endpoint: ENDPOINT, privateEndpoint: true } }, [user], {
        fetch: server.fetch,
        resolveHostname: privateResolver,
      }),
    );
    const tools = (await connector.discoverTools(context())).filter((tool) =>
      tool.name.includes("echo"),
    );
    expect(tools.map((tool) => [tool.name, tool.route?.connectorId])).toEqual([
      ["echo", "deployment"],
      ["installed.echo", "installed"],
    ]);
    const deploymentTool = tools[0]!;
    const events = await collect(
      connector.execute(
        {
          tool: deploymentTool.name,
          args: { text: "hi" },
          executionId: "call-1",
          route: deploymentTool.route,
        },
        context({ runId: "run-1" }),
      ),
    );
    expect(events[0]!.type).toBe("result");
    expect(server.seen.meta).toEqual([{ runId: "run-1" }]);
    expect(user.calls).toEqual([]);
  });

  it("refuses a user-owned provider that claims the deployment connector id", () => {
    expect(() =>
      createConnectorStack(
        false,
        undefined,
        deploymentConnectorProviders({ mcp: { endpoint: ENDPOINT, privateEndpoint: false } }, [
          provider("deployment", []),
        ]),
      ),
    ).toThrow(/Duplicate connector id deployment/);
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

  it("keeps the token out of a discovery failure", async () => {
    const connector = new DeploymentMcpConnector(
      { endpoint: ENDPOINT, token: TOKEN, privateEndpoint: true },
      {
        fetch: (async () => {
          throw new Error(`upstream rejected ${TOKEN}`);
        }) as typeof globalThis.fetch,
        resolveHostname: privateResolver,
      },
    );
    const error = await connector.discoverTools(context()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(TOKEN);
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
