# Fork patch set: deployment connectors

This fork adds a small patch set on top of upstream so one deployment can offer
its own MCP tools and keep users from adding any. Every change is off unless its
environment variable is set. An unconfigured instance behaves exactly like
upstream.

## Configuration

Set these on both the API and the worker. They read the same variables.

| Variable | Effect |
| --- | --- |
| `DEPLOYMENT_MCP_URL` | HTTPS URL of a deployment-owned MCP server. Its tools are offered to every run as connector `deployment`. |
| `DEPLOYMENT_MCP_TOKEN` | Optional bearer token sent to that server. Redacted from tool results and errors. |
| `DEPLOYMENT_MCP_PRIVATE_ENDPOINT` | `true` lets exactly the hostname in `DEPLOYMENT_MCP_URL` resolve to private addresses, for example a private service endpoint. The URL must be HTTPS with a DNS hostname. Every address it resolves to must be private. Loopback, link-local, metadata and unspecified addresses are refused. No other host, subdomain or IP literal is exempt, and `MCP_ALLOW_PRIVATE_ENDPOINT` is not involved. |
| `CONNECTOR_LOCKDOWN` | `true` stops users from adding their own MCP servers or connectors. It drops the `mcp` and `installed` connectors and refuses the `capabilities.install`, `mcp.*` and `integrationSetup.save` RPCs. It also removes the `add_mcp_server` built-in tool from every bot. |

Each tool call to the deployment server carries `runId` and `botId` in the MCP
request `_meta` when they are known, so the server can attribute a call to its
run without trusting tool arguments.

## Where the patch touches upstream

- `packages/adapters/src/deployment-connectors.ts` (new): config, the provider and the lock-down filter.
- `packages/adapters/src/remote-mcp.ts`: the `privateEndpointHost` policy, and `meta` on tool calls.
- `packages/adapters/src/executor.ts`: the deployment-wide `disabledBuiltinTools` dependency.
- `apps/api/src/connector-lockdown.ts` (new): the RPC interceptor.
- `apps/api/src/app.ts`, `apps/api/src/env.ts` and `apps/worker/src/index.ts`: one wrapper around each `createConnectorStack` provider list, plus the env read.
- `.github/workflows/public-fork-guard.yml` (new): fails when the tree, a commit message or a pull request's text carries deployment-specific values.

Only the `app` image changes. The `updater` and `computer` images are unaffected.

## Rebasing on upstream

1. `git fetch upstream && git switch -c rebase/<date> main`
2. `git rebase upstream/main`. Conflicts are limited to the files listed above. Keep upstream's change, then re-apply the wrapper call or the added field.
3. Run `pnpm lint`, `pnpm check` and `pnpm test`.
4. Open a pull request against this fork's `main`, and record the new upstream base commit below.

Upstream base: `08db24d87d47e5cc16f40b80a2a2e6ccc69442e7`.
