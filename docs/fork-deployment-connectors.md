# Fork patch set: deployment connector

This fork adds a small patch set on top of upstream. It lets a deployment offer its own
MCP server to every run, alongside the servers and connectors that users add
themselves. Nothing changes unless `DEPLOYMENT_MCP_URL` is set. An unconfigured
instance behaves exactly like upstream.

## Configuration

Set these on both the API and the worker. They read the same variables.

| Variable | Effect |
| --- | --- |
| `DEPLOYMENT_MCP_URL` | HTTPS URL of a deployment-owned MCP server. Its tools are offered to every run as connector `deployment`. |
| `DEPLOYMENT_MCP_TOKEN` | Optional bearer token for that server. It is redacted from tool results, tool errors and discovery errors. |
| `DEPLOYMENT_MCP_PRIVATE_ENDPOINT` | `true` lets exactly the hostname in `DEPLOYMENT_MCP_URL` resolve to private addresses, such as a private service endpoint. The URL must be HTTPS with a DNS hostname. Every address it resolves to must be RFC 1918 IPv4 or IPv6 unique-local; anything else is refused. No other host, subdomain or IP literal is exempt. `MCP_ALLOW_PRIVATE_ENDPOINT` is not involved. |

Each tool call to the deployment server carries `runId` and `botId` in the MCP
request `_meta` when they are known. The server can then attribute a call to its run
without trusting tool arguments.

## Coexisting with user-added sources

- The deployment server is registered ahead of every user-owned provider. When two
  tools share a name, the registry gives the bare name to the provider listed first.
  A user tool therefore cannot take a deployment tool's name. It is prefixed with its
  connector id instead, for example `installed.echo`.
- Startup fails if any other provider claims the `deployment` connector id.
- The deployment server lives in configuration, not in the database. The user RPCs
  for MCP servers, installs and integration settings edit database rows only, so
  they cannot change or remove it.

## Where the patch touches upstream

- `packages/adapters/src/deployment-connectors.ts` (new): config and the provider.
- `packages/adapters/src/remote-mcp.ts`: the `privateEndpointHost` policy, and `meta` on tool calls.
- `apps/api/src/app.ts`, `apps/api/src/env.ts` and `apps/worker/src/index.ts`: one wrapper around each `createConnectorStack` provider list, plus the env read.
- `.github/workflows/public-fork-guard.yml` (new): fails when the tree, a commit message or a pull request's text contains deployment-specific values.

Only the `app` image changes. The `updater` and `computer` images are unaffected.

## Rebasing on upstream

1. `git fetch upstream && git switch -c rebase/<date> main`
2. `git rebase upstream/main`. Conflicts can only occur in the files listed above.
   Keep upstream's change, then re-apply the wrapper call or the added field.
3. Run `pnpm lint`, `pnpm check` and `pnpm test`.
4. Open a pull request against this fork's `main`, and record the new upstream base
   commit below.

Upstream base: `08db24d87d47e5cc16f40b80a2a2e6ccc69442e7`.
