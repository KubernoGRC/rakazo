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

/** Connector id of the deployment-owned MCP server. User-added sources never use it. */
export const DEPLOYMENT_CONNECTOR_ID = "deployment";

export interface DeploymentMcpConfig {
  endpoint: string;
  token?: string;
  /** Exempt exactly the endpoint's hostname from the private-address block. */
  privateEndpoint: boolean;
}

export interface DeploymentConnectorConfig {
  /** A deployment-owned MCP server offered to every run. */
  mcp?: DeploymentMcpConfig;
}

export function deploymentConnectorConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DeploymentConnectorConfig {
  const endpoint = env.DEPLOYMENT_MCP_URL?.trim() || undefined;
  const token = env.DEPLOYMENT_MCP_TOKEN?.trim() || undefined;
  const privateEndpoint = env.DEPLOYMENT_MCP_PRIVATE_ENDPOINT === "true";
  if (!endpoint) {
    if (token || privateEndpoint) {
      throw new Error(
        "DEPLOYMENT_MCP_TOKEN and DEPLOYMENT_MCP_PRIVATE_ENDPOINT need DEPLOYMENT_MCP_URL",
      );
    }
    return {};
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
  return { mcp: { endpoint, token, privateEndpoint } };
}

/**
 * Puts the deployment MCP server ahead of the user-owned providers a composition root
 * built. The registry gives a colliding tool name to the provider listed first, so a
 * user-added tool can never take a deployment tool's name; it gets a prefixed one.
 * User sources are database rows the user RPCs edit, and this one is config, so those
 * RPCs cannot reach it.
 */
export function deploymentConnectorProviders(
  config: DeploymentConnectorConfig,
  providers: ConnectorProvider[],
  remote: RemoteTransportDependencies = {},
): ConnectorProvider[] {
  return config.mcp ? [new DeploymentMcpConnector(config.mcp, remote), ...providers] : providers;
}

/** An MCP server the deployment owner configures; users cannot change or remove it. */
export class DeploymentMcpConnector implements ConnectorProvider {
  constructor(
    private readonly config: DeploymentMcpConfig,
    private readonly remote: RemoteTransportDependencies = {},
  ) {}

  describe() {
    return {
      id: DEPLOYMENT_CONNECTOR_ID,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { discover: true, oauth: false, secretsBrokered: true },
    };
  }

  async discoverTools(context: AdapterContext): Promise<ConnectorTool[]> {
    try {
      return await listRemoteMcpTools(this.options(context));
    } catch (error) {
      // The registry logs discovery failures; keep the token out of that log.
      throw new Error(sanitizeConnectorError(error, this.secrets()));
    }
  }

  async *execute(call: ConnectorCall, context: AdapterContext): AsyncIterable<ConnectorEvent> {
    const secrets = this.secrets();
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

  private secrets(): string[] {
    return this.config.token ? [this.config.token] : [];
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
