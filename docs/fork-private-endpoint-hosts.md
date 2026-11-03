# Private endpoint hosts for user MCP servers

`MCP_PRIVATE_ENDPOINT_HOSTS` lets user-configured remote MCP servers reach a short list
of operator-named hosts on private addresses. Every other private host stays refused.

## Why

A deployment may run MCP servers next to Rakazo on its own private network, such as a
runner that keeps vendor stdio packages out of the worker. Each user still adds the
server as their own row with their own credential. Upstream offers one way to reach
such a host, `MCP_ALLOW_PRIVATE_ENDPOINT=true`. That flag is instance-wide, so any user's
row could then point at any private address, including the deployment's own services.

## What it does

- `MCP_PRIVATE_ENDPOINT_HOSTS` is a comma-separated list of exact DNS names. Entries are
  lower-cased and a trailing dot is dropped. An IP literal, a wildcard, a port, a path or
  a single-label name is refused at startup.
- Each listed host gets the same rules as the deployment connector's pinned private host
  (`privateEndpointHost` in `packages/adapters/src/remote-mcp.ts`): HTTPS only, and every
  address it resolves to must be RFC 1918 IPv4 or fd00::/8. Cloud metadata, link-local,
  loopback and shared address space stay refused. The check runs both before the request
  and in the connection's DNS lookup.
- The list applies when a user saves a remote server and when the API or the worker
  connects to one. `MCP_ALLOW_PRIVATE_ENDPOINT` is unchanged and still off by default.

## Files

- `packages/adapters/src/mcp-private-endpoint-hosts.ts` (new): parses the variable.
- `packages/adapters/src/remote-mcp.ts`: `privateEndpointHosts` beside `privateEndpointHost`.
- `packages/adapters/src/mcp-transport.ts`, `packages/adapters/src/mcp-connector.ts`:
  pass the list to the session's fetch.
- `apps/api/src/mcp-servers.ts`, `apps/api/src/router.ts`, `apps/api/src/app.ts`: the
  save-time check.
