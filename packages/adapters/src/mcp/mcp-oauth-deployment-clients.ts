import { parseMcpOAuthAuthorizationParams } from "@rakazo/contracts";

/**
 * An OAuth client the deployment registered with an authorization server, used for every
 * user whose MCP server authorizes there. Authorization servers without dynamic client
 * registration otherwise need a client in each user's own server row, which hands every
 * user the client secret. The secret stays in the deployment's environment and is never
 * written to a user's stored material.
 */
export interface DeploymentOAuthClient {
  /** The authorization server (issuer) URL, normalized. */
  issuer: string;
  client_id: string;
  client_secret?: string;
  scope?: string;
  /** Extra authorization request parameters, query-string form. */
  authorization_params?: string;
}

/** Deployment clients by normalized issuer URL. */
export type DeploymentOAuthClients = ReadonlyMap<string, DeploymentOAuthClient>;

const LABEL = /^[A-Z][A-Z0-9_]{0,31}$/;

/**
 * Read deployment OAuth clients from the environment. `MCP_OAUTH_CLIENTS` lists labels,
 * comma-separated; each label `L` reads:
 *
 * - `MCP_OAUTH_CLIENT_L_ISSUER` (required): the authorization server URL, HTTPS;
 * - `MCP_OAUTH_CLIENT_L_ID` (required);
 * - `MCP_OAUTH_CLIENT_L_SECRET` (optional; a public client has none);
 * - `MCP_OAUTH_CLIENT_L_SCOPE` and `MCP_OAUTH_CLIENT_L_AUTHORIZATION_PARAMS` (optional).
 *
 * A malformed configuration throws, so a deployment fails at startup rather than falling
 * back to per-user clients or dynamic registration for a server it meant to configure.
 */
export function deploymentOAuthClientsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DeploymentOAuthClients {
  const listed = env.MCP_OAUTH_CLIENTS?.trim();
  const clients = new Map<string, DeploymentOAuthClient>();
  if (!listed) return clients;
  for (const raw of listed.split(",")) {
    const label = raw.trim();
    if (!LABEL.test(label))
      throw new Error(`MCP_OAUTH_CLIENTS: ${JSON.stringify(label)} is not a valid label`);
    const read = (field: string) => env[`MCP_OAUTH_CLIENT_${label}_${field}`]?.trim() || undefined;
    const issuer = normalizedIssuer(read("ISSUER"), label);
    const clientId = read("ID");
    if (!clientId) throw new Error(`MCP_OAUTH_CLIENT_${label}_ID is required`);
    const authorizationParams = read("AUTHORIZATION_PARAMS");
    if (authorizationParams) {
      try {
        parseMcpOAuthAuthorizationParams(authorizationParams);
      } catch (error) {
        throw new Error(
          `MCP_OAUTH_CLIENT_${label}_AUTHORIZATION_PARAMS: ${(error as Error).message}`,
        );
      }
    }
    if (clients.has(issuer))
      throw new Error(`MCP_OAUTH_CLIENTS configures ${issuer} more than once`);
    const secret = read("SECRET");
    const scope = read("SCOPE");
    clients.set(issuer, {
      issuer,
      client_id: clientId,
      ...(secret ? { client_secret: secret } : {}),
      ...(scope ? { scope } : {}),
      ...(authorizationParams ? { authorization_params: authorizationParams } : {}),
    });
  }
  return clients;
}

function normalizedIssuer(value: string | undefined, label: string): string {
  const name = `MCP_OAUTH_CLIENT_${label}_ISSUER`;
  if (!value) throw new Error(`${name} is required`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an HTTPS URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search)
    throw new Error(`${name} must be an HTTPS URL without credentials, query or fragment`);
  return url.href;
}

/** The deployment client for an authorization server, if the deployment configures one. */
export function deploymentClientFor(
  clients: DeploymentOAuthClients,
  authorizationServer: string | undefined,
): DeploymentOAuthClient | undefined {
  if (!authorizationServer || clients.size === 0) return undefined;
  try {
    return clients.get(new URL(authorizationServer).href);
  } catch {
    return undefined;
  }
}

let fromProcessEnv: DeploymentOAuthClients | undefined;

/** This process's deployment clients, read from its environment once. */
export function processDeploymentOAuthClients(): DeploymentOAuthClients {
  fromProcessEnv ??= deploymentOAuthClientsFromEnv(process.env);
  return fromProcessEnv;
}

/** Secrets of deployment clients (by default, this process's), for redaction. */
export function deploymentOAuthClientSecrets(
  clients: DeploymentOAuthClients = processDeploymentOAuthClients(),
): string[] {
  return [...clients.values()].flatMap((client) =>
    client.client_secret ? [client.client_secret] : [],
  );
}
