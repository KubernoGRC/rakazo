# Fork patch set: per-call tool events

Upstream records security events for sign-ins, credentials, settings, approval decisions and
refused destinations, but not for the tool calls an agent makes. This patch set adds a
`tool.called` security event for every call, so each call can be attributed to the user whose
run made it. It is generic and is offered upstream.

## What it records

One event per call to `applyTool`, however the call ends: run, refused, waiting for approval,
replayed from an earlier attempt, failed or cancelled. The event is content-free, like every
security event:

| Field | Value |
| --- | --- |
| `userId`, `spaceId` | The run's owner and Space |
| `metadata.tool` | The tool name, or `(unknown)` when the model asked for a tool the run does not have |
| `metadata.connector`, `metadata.remoteTool`, `metadata.resourceId` | The connector route the call resolved to, if any |
| `metadata.host` | An MCP server's endpoint hostname, or `stdio:<command> <package>` for a local one |
| `metadata.argsSha256`, `metadata.argsBytes` | SHA-256 and size of the arguments' canonical JSON |
| `metadata.resultBytes` | Size of the result, when the tool ran |
| `metadata.outcome` | `ok`, `error`, `refused`, `replayed`, `approval_requested`, `input_requested` or `cancelled` |
| `metadata.approval`, `metadata.approvalId` | `person` with the approved effect's id, `policy`, or `none` |
| `metadata.runId`, `metadata.threadId`, `metadata.botId`, `metadata.durationMs` | Where and how long |

`approval.decided` now also carries `effectId`, so a call a person approved joins to the
decision.

The argument hash is unkeyed. It identifies a call for correlation with the run's own record of
its arguments, but short arguments can be guessed from it, so treat the events with the same care
as the thread history they point at.

## Where it touches upstream files

- `packages/contracts/src/security-events.ts`: one event type.
- `packages/adapters/src/run-tools.ts`: `applyTool` runs the dispatch inside `auditToolCall`, which
  is told the resolved request and the call that passed its gate.
- `packages/db/src/events.ts`: `approval.decided` carries `effectId`.
- `docs/self-host.md`: the event and an alert query.

Everything else is in `packages/adapters/src/tool-call-event.ts` and its tests.
