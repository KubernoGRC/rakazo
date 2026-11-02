# Fork patch set: deployment OAuth clients

Remote MCP servers whose authorization server offers no dynamic client registration
need an OAuth client registered out of band. Upstream stores that client, secret
included, in each user's own MCP server record. Every user who connects would then
hold the client secret, and each user could point their record at a different client.

This patch set lets the deployment register those clients once. Each user still grants
their **own** access through it. Nothing changes unless `MCP_OAUTH_CLIENTS` is set.

## Configuration

Set these on both the API and the worker. Like the other fork settings, the compose
files don't carry them; the deployment's own compose overlay or env file passes them
(`infra/updater/src/compose-env.test.ts` lists them as deployment-supplied).

| Variable | Meaning |
| --- | --- |
| `MCP_OAUTH_CLIENTS` | Comma-separated labels, for example `GITHUB,ENTRA`. Each label is upper case. |
| `MCP_OAUTH_CLIENT_<LABEL>_ISSUER` | Required. The authorization server URL: HTTPS, with no credentials, query or fragment. |
| `MCP_OAUTH_CLIENT_<LABEL>_ID` | Required. The client id. |
| `MCP_OAUTH_CLIENT_<LABEL>_SECRET` | Optional; a public client has none. Keep it with the deployment's other credentials. |
| `MCP_OAUTH_CLIENT_<LABEL>_SCOPE` | Optional. The scope to request. |
| `MCP_OAUTH_CLIENT_<LABEL>_AUTHORIZATION_PARAMS` | Optional. Extra authorization request parameters, in query-string form. |

A malformed configuration stops the API and the worker at startup. They don't fall
back to per-user clients for a server the deployment meant to configure.

## Behaviour

- When a user's MCP OAuth flow reaches a configured authorization server, the
  deployment's client is used. For a remote server, that is the server the MCP endpoint
  advertises. For a stdio server, it is the one its client record names.
- The deployment's client **overrides** any client the user stored for that server.
  The deployment decides which app, and so which permissions, a user can grant there.
  Users' own clients still work for every other authorization server.
- The client is used for the authorization request, the code exchange and refresh.
  It is never written into a user's stored material, so the secret never reaches a
  user's secret record.
- A stdio server's `{{oauth.client_id}}` and `{{oauth.scope}}` templates read the
  deployment client. `{{oauth.client_secret}}` is **not** available for a deployment
  client, because the secret is never handed to a server process.
- A deployment client is used only when the discovered authorization-server metadata
  names its configured issuer, and the metadata's authorization and token endpoints are
  on that issuer's origin. Discovery can fall back to metadata the MCP endpoint itself
  serves, so the check applies however the metadata was obtained. A flow that fails it
  is refused rather than sent the secret.
- The secrets are redacted from OAuth errors, logs and tool results.

## Where it touches upstream files

- `packages/adapters/src/mcp-oauth.ts`: `effectiveClient` picks the client in the
  provider, the refresh and the stdio launch values. The broker takes the deployment
  clients (by default, read from the process environment) and passes them to its
  providers and to error redaction.
- `packages/adapters/src/mcp-connector.ts`: stdio OAuth templates read
  `launchOAuthClient`.
- `packages/adapters/src/mcp-oauth.test.ts`: the deployment-client cases sit next to
  the pre-registered client tests, reusing their fake servers.

Everything else is in `packages/adapters/src/mcp-oauth-deployment-clients.ts` and its
tests.
