# Fork patch set: model relay for isolated computers

A computer with isolated egress ([isolated computer egress](fork-isolated-computer-egress.md))
has no route off the host. A coding CLI running in it still needs a model, but the
deployment's model credential must never enter the computer. The relay closes that gap:

- it is a small service, run as **its own container**, which the supervisor joins to every
  isolated computer network as a peer (`SANDBOX_ISOLATED_PEERS`);
- the computer presents a **per-run capability**;
- the relay checks the capability and forwards the call to the model endpoint with the
  deployment's own credential.

Nothing changes unless the relay is started.

## What it forwards

Only Bedrock runtime `InvokeModel` and `InvokeModelWithResponseStream`:

- `POST /model/{modelId}/invoke`
- `POST /model/{modelId}/invoke-with-response-stream`

Anything else returns 404. A Bedrock client in the computer uses the relay as its endpoint
(base URL `http://<relay>:8790`) and sends the capability as its bearer token
(`Authorization: Bearer …`), or in `x-rakazo-capability`.

**Request headers.** Only `content-type`, `accept` and the two `x-amzn-bedrock-*` content
headers go upstream. The caller's other headers, credentials included, are dropped, and the
relay sets `Authorization: Bearer <deployment token>` itself. Redirects are refused.

**Response headers.** Only `content-type`, `x-amzn-requestid` and
`x-amzn-bedrock-content-type` come back. The body is streamed through.

## Capabilities

`rkc1.<base64url payload>.<base64url HMAC-SHA256>`, signed with `MODEL_RELAY_SIGNING_KEY`.
The payload is:

| Field | Meaning |
|---|---|
| `id` | Random id, at least 16 characters |
| `run`, `user` | The run and user it was issued for, recorded on every event |
| `model` | The one model id it may invoke. It must also be in `MODEL_RELAY_MODELS`. |
| `exp` | Expiry, ms since the epoch |
| `max` | Maximum number of model requests |

The issuer is the worker. The format is shared with
`packages/adapters/src/model-relay-capability.ts`, and both test suites assert one fixed
vector.

**Refusals:**

| Status | When |
|---|---|
| 401 | Missing, malformed or wrongly signed |
| 403 | Expired, revoked, or the wrong model |
| 429 | Allowance used |
| 413 | Body over `MODEL_RELAY_MAX_BODY_BYTES` |
| 503 | The relay has no credential |
| 502 | The upstream is unreachable |

**Rechecks.** Expiry and revocation are checked again after the request body has been
read, before the allowance is used, so a slow body can't outlast its capability.

**Revocation.** `POST /capabilities/revoke`, presenting the capability, ends it early. The
issuer calls it when a run ends. Counts and revocations are in memory, so after a relay
restart **the expiry is the bound that always holds**. Keep capabilities short-lived.

## Configuration

| Variable | |
|---|---|
| `MODEL_RELAY_SIGNING_KEY` | Required, 32+ characters. Shared with the issuer only. |
| `MODEL_RELAY_MODELS` | Required. Comma-separated model ids a capability may name. |
| `AWS_BEARER_TOKEN_BEDROCK` or `MODEL_RELAY_UPSTREAM_TOKEN_FILE` | The upstream credential. The file is re-read on every request, so rotation needs no restart. |
| `MODEL_RELAY_UPSTREAM` | Default `https://bedrock-runtime.<AWS_REGION>.amazonaws.com`. HTTPS only, no credentials or query. |
| `MODEL_RELAY_PORT`, `MODEL_RELAY_HOST` | Default `8790`, `0.0.0.0` |
| `MODEL_RELAY_MAX_BODY_BYTES` | Default 20 MiB |

Run it from the app image, as its own service, with no Docker socket and no other app
secrets:

```yaml
model-relay:
  image: <app image>
  command: ["pnpm", "--filter", "@rakazo/sandbox-supervisor", "exec", "tsx", "src/model-relay-main.ts"]
  read_only: true
  security_opt: ["no-new-privileges:true"]
```

The supervisor then needs `SANDBOX_ISOLATED_PEERS=<the relay's container name>`.

## Audit

Every request logs exactly one JSON line to stdout: `model.relayed`, or
`model.relay.refused` with a reason, or `model.relay.revoked`. A streamed response whose
upstream fails, or that the computer stops reading, is logged with a reason. Each line carries:

- a hash label of the capability id;
- the run, user and model;
- whether the call streamed;
- the status;
- the request and response sizes;
- the duration.

Neither the capability nor the credential is ever logged.

## Tests

`model-relay.test.ts` covers:

- the signature, tampering, expiry and shape checks;
- the shared vector;
- the header and path parsing;
- that a call goes upstream with the relay's credential and never the caller's;
- each refusal, the allowance, revocation and the body limit;
- token-file rotation;
- a 502 when the upstream is unreachable;
- the configuration refusals.
