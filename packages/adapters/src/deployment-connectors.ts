import { isIP } from "node:net";
import type {
  AdapterContext,
  ConnectorCall,
  ConnectorEvent,
  ConnectorProvider,
  ConnectorTool,
} from "@rakazo/adapter-kit";
import { redactConnectorPayload, sanitizeConnectorError } from "./connector-safety.js";
import type { RemoteMcpOptions, RemoteTransportDependencies } from "./remote-mcp.js";
import { callRemoteMcpTool, listRemoteMcpTools } from "./remote-mcp.js";

/** Connectors a lock-down deployment drops: user-added MCP servers and installs. */
export const USER_MANAGED_CONNECTOR_IDS: ReadonlySet<string> = new Set(["mcp", "installed"]);
/** Built-in tools a lock-down deployment removes from every run. */
export const LOCKDOWN_DISABLED_BUILTIN_TOOLS: readonly string[] = ["add_mcp_server"];

export interface DeploymentMcpConfig {
  endpoint: string;
  token?: string;
  /** Exempt exactly the endpoint's hostname from the private-address block. */
  privateEndpoint: boolean;
}

export interface DeploymentConnectorConfig {
  /** Users cannot add their own MCP servers or connectors. */
  lockdown: boolean;
  /** A deployment-owned MCP server offered to every run. */
  mcp?: DeploymentMcpConfig;
}

export function deploymentConnectorConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DeploymentConnectorConfig {
  const endpoint = env.DEPLOYMENT_MCP_URL?.trim() || undefined;
  const token = env.DEPLOYMENT_MCP_TOKEN?.trim() || undefined;
  const privateEndpoint = env.DEPLOYMENT_MCP_PRIVATE_ENDPOINT === "true";
  const lockdown = env.CONNECTOR_LOCKDOWN === "true";
  if (!endpoint) {
    if (token || privateEndpoint) {
      throw new Error(
        "DEPLOYMENT_MCP_TOKEN and DEPLOYMENT_MCP_PRIVATE_ENDPOINT need DEPLOYMENT_MCP_URL",
      );
    }
    return { lockdown };
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("DEPLOYMENT_MCP_URL must be an HTTPS URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("DEPLOYMENT_MCP_URL must be an HTTPS URL");
  }
  if (privateEndpoint && isIP(url.hostname.replace(/^\[|\]$/g, "")) !== 0) {
    throw new Error("DEPLOYMENT_MCP_PRIVATE_ENDPOINT needs a DNS hostname, not an IP address");
  }
  return { lockdown, mcp: { endpoint, token, privateEndpoint } };
}

/** Applies the deployment's connector policy to the providers a composition root built. */
export function deploymentConnectorProviders(
  config: DeploymentConnectorConfig,
  providers: ConnectorProvider[],
  remote: RemoteTransportDependencies = {},
): ConnectorProvider[] {
  const kept = config.lockdown
    ? providers.filter((provider) => !USER_MANAGED_CONNECTOR_IDS.has(provider.describe().id))
    : providers;
  return config.mcp ? [...kept, new DeploymentMcpConnector(config.mcp, remote)] : kept;
}

export function deploymentDisabledBuiltinTools(config: DeploymentConnectorConfig): string[] {
  return config.lockdown ? [...LOCKDOWN_DISABLED_BUILTIN_TOOLS] : [];
}

/** An MCP server the deployment owner configures; users cannot change or remove it. */
export class DeploymentMcpConnector implements ConnectorProvider {
  constructor(
    private readonly config: DeploymentMcpConfig,
    private readonly remote: RemoteTransportDependencies = {},
  ) {}

  describe() {
    return {
      id: "deployment",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { discover: true, oauth: false, secretsBrokered: true },
    };
  }

  discoverTools(context: AdapterContext): Promise<ConnectorTool[]> {
    return listRemoteMcpTools(this.options(context));
  }

  async *execute(call: ConnectorCall, context: AdapterContext): AsyncIterable<ConnectorEvent> {
    const secrets = this.config.token ? [this.config.token] : [];
    try {
      const result = await callRemoteMcpTool(
        { ...this.options(context), meta: callMeta(context) },
        call.tool,
        call.args,
      );
      yield { type: "result", data: redactConnectorPayload(result, secrets) };
    } catch (error) {
      yield { type: "error", message: sanitizeConnectorError(error, secrets) };
    }
  }

  private options(context: AdapterContext): RemoteMcpOptions {
    const { endpoint, token, privateEndpoint } = this.config;
    return {
      ...this.remote,
      endpoint,
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
      signal: context.signal,
      privateEndpointHost: privateEndpoint ? new URL(endpoint).hostname : undefined,
    };
  }
}

/** Lets the server attribute a call to its run and bot without trusting tool arguments. */
function callMeta(context: AdapterContext): Record<string, string> | undefined {
  const meta: Record<string, string> = {};
  if (context.runId) meta.runId = context.runId;
  if (context.botId) meta.botId = context.botId;
  return Object.keys(meta).length > 0 ? meta : undefined;
}
