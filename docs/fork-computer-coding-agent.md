# Fork patch set: the computer coding agent

`CLOUD_AGENT_PROVIDER=computer` runs a headless coding command (for example Claude Code)
for a repository task. It runs **inside a single-use Rakazo computer with no route off the
host**, and it reuses upstream's cloud-agent tools, ownership, cards and recovery
([cloud agents](self-host/cloud-agents.md)). Nothing is pushed: the result is a diff and a
summary that the user reviews. Publishing is a separate, explicitly approved step that this
patch set doesn't include.

It builds on two other patch sets:

- [isolated computer egress](fork-isolated-computer-egress.md);
- [the model relay](fork-computer-model-relay.md).

## A run

1. `cloud_agent_launch` (normal tool approval) with a `repository` URL on the allowlist and
   a prompt. The prompt is the task brief. Image attachments are refused, since the run
   could never see them.
2. In the **worker**, the provider reads the run owner's own forge token: the OAuth token
   their MCP connection already holds for the forge's authorization server
   (`CLOUD_AGENT_COMPUTER_FORGE_ISSUER`, default `https://github.com/login/oauth`). If the
   user has no such connection, the launch fails.
3. With that token, the worker resolves the default branch's head SHA and downloads its
   tarball. The token never enters the computer.
4. The worker provisions computer `coding-<agent id>` with `egress: "none"`. It refuses a
   sandbox provider without `isolatedEgress`.
5. **Isolation probe.** A public address and an external name must both be unreachable from
   the computer. Otherwise the computer is destroyed and the run fails.
6. The worker writes three things into the computer: the snapshot (in chunks), the brief and
   a run script. It issues a relay capability bound to the run, the user, one model, the
   deadline and a request allowance. Then it starts the command detached (`setsid -f`),
   with every inherited stream closed so the exec returns at once.
7. **The run script** does the following:
   - unpacks the snapshot and commits it as a baseline, keeping its SHA;
   - runs the command with the brief as its last argument, under `timeout`;
   - then records `git diff --binary` and `--numstat` against that baseline (so work the
     command committed itself is kept) and the exit code.
8. `get` polls for the exit file. When the command has finished, the worker keeps the diff
   and the summary (the tail of the command's output) under
   `DATA_DIR/cloud-agents/<id>/`. Then it:
   - revokes the capability;
   - destroys the computer;
   - deletes its home.

   The run fails when:
   - the diff changes a binary file;
   - the diff exceeds `CLOUD_AGENT_COMPUTER_MAX_DIFF_BYTES`;
   - the command exits non-zero;
   - the deadline passes.

   A result that can't be read is never reported as an empty diff. The computer is kept
   and the read is retried, until an hour past the deadline.
9. **Teardown** has its own bounded signal. The run turns terminal only once the computer
   is gone; until then the intent is kept and every poll or cancel retries. A lost computer
   reference is recovered by provisioning the run's bot id, which is idempotent.
10. `cloud_agent_status` returns the snapshot plus `result`: the status, the repository, the
   base SHA, the summary, and the diff, truncated at 60 kB, with its full size.

`cloud_agent_reply` isn't supported, because each computer is single-use; a follow-up is a
new launch. `cloud_agent_cancel` tears the computer down.

## Configuration (worker)

| Variable | |
|---|---|
| `CLOUD_AGENT_PROVIDER` | `computer` |
| `CLOUD_AGENT_SPACE_ID` | The one Space the provider serves |
| `CLOUD_AGENT_COMPUTER_COMMAND` | JSON argv, e.g. `["claude","-p","--max-turns","200"]` |
| `CLOUD_AGENT_COMPUTER_ENV` | JSON object of environment for the command. `{{relay_url}}` and `{{capability}}` are filled in. |
| `CLOUD_AGENT_COMPUTER_REPOS` | Allowed repositories, `owner/name`, comma-separated |
| `CLOUD_AGENT_COMPUTER_RELAY_URL` | The relay as the computer reaches it, e.g. `http://model-relay:8790` |
| `CLOUD_AGENT_COMPUTER_MODEL` | The model id the capability names. It must be in the relay's `MODEL_RELAY_MODELS`. |
| `MODEL_RELAY_SIGNING_KEY` | Shared with the relay only |
| `CLOUD_AGENT_COMPUTER_FORGE_ISSUER` | Default `https://github.com/login/oauth` |
| `CLOUD_AGENT_COMPUTER_FORGE_API` | Default `https://api.github.com` |
| `CLOUD_AGENT_COMPUTER_DEADLINE_MS`, `_MAX_REQUESTS`, `_MAX_DIFF_BYTES` | Default 1 h, 1000 and 1 MiB |

The API needs only `CLOUD_AGENT_PROVIDER` and `CLOUD_AGENT_SPACE_ID`. It reads results and
holds none of the other settings.

For Claude Code on Bedrock through the relay, the command environment is:

```json
{
  "CLAUDE_CODE_USE_BEDROCK": "1",
  "ANTHROPIC_BEDROCK_BASE_URL": "{{relay_url}}",
  "AWS_BEARER_TOKEN_BEDROCK": "{{capability}}",
  "AWS_REGION": "us-east-1",
  "ANTHROPIC_MODEL": "<the model id>",
  "ANTHROPIC_SMALL_FAST_MODEL": "<the same id>"
}
```

Verify these settings against the pinned CLI version before relying on them.

## What holds

- **The computer holds no forge token, deployment credential or app secret.**
  - The forge token is used only in the worker.
  - The capability is valid only at the relay, for one model, until the deadline.
- **The computer can't send anything out.** The supervisor's internal network is the
  boundary, and the provider's probe checks it before the command starts.
- **Runs are per user.**
  - Upstream binds each agent to its initiating user.
  - The snapshot is fetched with that user's own token.
  - Every relay event names the user.
- **Nothing is published.** There is no push, branch or PR code path in this patch set.

## Tests

- `computer-cloud-agent.test.ts` covers:
  - configuration;
  - repository and numstat parsing;
  - the run script's ordering;
  - an isolated launch whose forge token appears in no sandbox call or file;
  - idempotent replay;
  - each refusal;
  - the probe teardown;
  - finish, binary, oversized and unreadable diffs;
  - the deadline and cancel;
  - the read-only API mode;
  - the forge token resolver.
- `model-relay-capability.test.ts` asserts the relay's shared vector.
- `cloud-agent-conformance.test.ts` covers the Space binding and the shared key, and that
  the API holds no runtime.
