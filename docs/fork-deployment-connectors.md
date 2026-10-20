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
| `DEPLOYMENT_MCP_PRIVATE_ENDPOINT` | `true` lets exactly the hostname in `DEPLOYMENT_MCP_URL` resolve to private addresses, such as a private service endpoint. The URL must be HTTPS with a DNS hostname. Every address it resolves to must be RFC 1918 IPv4 or IPv6 unique-local (`fd00::/8`). Cloud metadata addresses (including AWS's `fd00:ec2::254`), link-local and loopback addresses are refused even inside those ranges. Anything else is refused too. No other host, subdomain or IP literal is exempt. `MCP_ALLOW_PRIVATE_ENDPOINT` is not involved. |

Each tool call to the deployment server includes `runId`, `botId`, `userId` and
`spaceId` in the MCP request `_meta`. A field that is not known for a call is left
out; a system run, for example, has no user. Other connectors never receive these
fields. They are attribution hints that this instance asserts, not credentials. The
server may record them in audit entries and use them to link a call to its
conversation. It must never grant rights based on them.

## Coexisting with user-added sources

- The deployment server is registered ahead of every user-owned provider. When two
  tools share a name, the registry gives the bare name to the provider listed first.
  A user tool therefore cannot take a deployment tool's name. It is prefixed with its
  connector id instead, for example `installed.echo`.
- Startup fails if any other provider claims the `deployment` connector id.
- The deployment server lives in configuration, not in the database. The user RPCs
  for MCP servers, installs and integration settings edit database rows only, so
  they cannot change or remove it.

## Computer hardening on resume

Upstream creates every computer unprivileged. It drops every capability, sets
`no-new-privileges`, runs as UID 1000, maps no devices, mounts only the bot's
home, and sets resource ceilings (`containerCreateOptions` in
`infra/sandboxes/supervisor/src/computer-spec.ts`). That is what keeps a computer
from rewriting the host's netfilter rules, reading another bot's home, or
starving the host.

Upstream's resume path, though, reuses an existing `rakazo.managed` container
after checking only its image, user, network and home mount. A container created
some other way (an older build, a hand-run `docker run`, a compose override) was
started with whatever privileges it had.

The fork builds the expected options with the same `containerCreateOptions` call
that create uses, from one shared input. The inspected container must then match
on every field in `SPEC_FIELDS`
(`infra/sandboxes/supervisor/src/computer-hardening.ts`):

- privileged mode and capabilities;
- `SecurityOpt` as an exact set;
- devices;
- network, PID, IPC, UTS and user namespaces;
- binds, mounts, volumes-from and tmpfs;
- read-only paths, and masked paths (which must include Docker's default list);
- sysctls;
- memory, swap, CPU, PID and shm ceilings;
- published ports and `PublishAllPorts`;
- the user;
- attachment to no network other than its own.

A container that differs is replaced. The check is structural, not a deny-list:
a field create leaves unset must hold Docker's isolated default. A test fails
when create sets a field the check does not cover.

This check is not behind a flag. A container create built matches it as reported
by a live Docker daemon, so an otherwise unpatched instance resumes exactly as
before. One consequence: changing `RAKAZO_COMPUTER_MEMORY`, `_CPUS` or
`_PIDS_LIMIT` now replaces each computer at its next resume, so the new ceiling
applies.

## Where the patch touches upstream

- `packages/adapters/src/deployment-connectors.ts` (new): config and the provider.
- `packages/adapters/src/remote-mcp.ts`: the `privateEndpointHost` policy, and `meta` on tool calls.
- `apps/api/src/app.ts`, `apps/api/src/env.ts` and `apps/worker/src/index.ts`: one wrapper around each `createConnectorStack` provider list, plus the env read.
- `infra/sandboxes/supervisor/src/computer-hardening.ts` (new): the hardening check. `infra/sandboxes/supervisor/src/index.ts`: one import, a shared `createInput` for resume and create, and one term in the resume predicate.
- `.github/workflows/public-fork-guard.yml` and `.github/scripts/public-fork-guard*.sh` (new): fail when any introduced commit's tree, any commit message or a pull request's text contains deployment-specific values, or when gitleaks finds a credential in an introduced commit's patch, a commit message or the pull request text. Each commit is scanned, so a value added and then removed is still caught. Commits already on upstream's `main` are excluded. The guard's self-test plants generated values and must see them fail before the scan runs.

Only the `app` image changes. The supervisor runs from it. The `updater` and `computer` images are unaffected.

## Rebasing on upstream

1. `git fetch upstream && git switch -c rebase/<date> main`
2. `git rebase upstream/main`. Conflicts can only occur in the files listed above.
   Keep upstream's change, then re-apply the wrapper call or the added field.
3. Run `pnpm lint`, `pnpm check` and `pnpm test`.
4. Open a pull request against this fork's `main`, and record the new upstream base
   commit below.

Upstream base: `08db24d87d47e5cc16f40b80a2a2e6ccc69442e7`.
