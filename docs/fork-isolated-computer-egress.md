# Fork patch set: isolated computer egress

A provision can ask for a computer with **no route off the host**. Such a computer
reaches only its network's peers:

- the supervisor;
- the screen peers;
- the containers the operator names.

It is meant for a computer that runs untrusted work and must not send anything out,
such as a coding agent reading issue text. Nothing changes for a provision that
doesn't ask.

## Asking for it

- `SandboxProvider.provision` takes `egress?: "default" | "none"`. Only a provider whose
  `describe().capabilities.isolatedEgress` is true accepts `none`. A caller must check
  that flag first. Providers without it ignore the field.
- The Docker provider sends `egress: "none"` to the supervisor only when asked, and
  **fails the provision** unless the supervisor's answer echoes `egress: "none"`. An older
  supervisor that drops the field therefore never yields an open computer.

## What the supervisor does

`POST /computers` accepts `egress: "default" | "none"` (default `default`).

- **The topology:** `none` requires per-bot networks (`SANDBOX_SCREEN_NETWORK=isolated`).
  Anything else returns 400.
- **Host services:** an internal network has no route off the host, but its containers can
  still reach services the host binds on the bridge's address. So `none` also requires one
  of the following, or it returns 400:
  - **Docker Engine API 1.50 or later.** The network's gateway is then created in
    `isolated` gateway mode, with no address on the host.
  - **`SANDBOX_COMPUTER_EGRESS=restricted`.** The host rules' `INPUT` drop then covers the
    computer's named bridge.
- **The network:** the computer's network is created with Docker's `Internal` flag, so it
  has no route out, and with the label `rakazo.egress=none`.
- **Peers:** the containers named in `SANDBOX_ISOLATED_PEERS` (comma-separated container
  names, operator-set only) are joined to it on create and on every resume. A model relay
  is the typical peer.
  - Any other endpoint, such as a peer since removed from the setting, is disconnected.
    Only the computer, the supervisor and the screen peers stay.
  - A peer that can't be joined, or an endpoint that can't be removed, fails the
    provision. A network created by that provision is removed again.
  - Peers don't keep a stopped computer's network in use.
- **Resume:** an isolated request resumes a computer only when its network's internal flag
  and label match. Otherwise its network is replaced. If the old network can't be removed,
  the bot's containers are stopped and the provision fails, because attaching to it would
  give an isolated computer a route out. A default request resumes a computer on an
  isolated network as it is: it has less egress, never more.
- **Response:** the answer to every provision carries the `egress` it applied.

## Limits

- A peer is reachable, so it must not be a general proxy unless that is intended.
- Whether Docker's embedded resolver forwards external lookups from an internal network
  depends on the engine version. Where it does, name lookups leave through the daemon,
  which is a channel for small amounts of data. Test a lookup of an external name from an
  isolated computer before relying on it.
- The supervisor itself is reachable, as for every computer. Its API requires the
  supervisor token.

## Tests

- `computer-spec.test.ts`: the network options, egress matching and peer parsing.
- `index.test.ts`: the 400 outside the per-bot topology.
- `docker-sandbox.test.ts`: the request body, and the fail-closed echo check.
