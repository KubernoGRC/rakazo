# Fork patch set: OIDC group gate

This fork can restrict sign-in to the members of one identity-provider group. It is
built for Microsoft Entra ID, but it reads only a standard `groups` claim, so any
OpenID Connect provider that emits one works. Nothing changes unless
`OIDC_REQUIRED_GROUP` is set. An unconfigured instance behaves exactly like upstream.

It builds on upstream's optional OpenID Connect SSO (see [self-host.md](self-host.md)).
Issuer discovery, PKCE, ID-token verification and account binding are upstream's.
The fork adds only the group check and what it needs to be the sole way in.

## Configuration

Set these on the API. The worker does not authenticate users and does not read them.

| Variable | Value under the gate |
| --- | --- |
| `OIDC_REQUIRED_GROUP` | The group's object ID, exactly as it appears in the ID token's `groups` claim. Once the variable is present at all, the gate is on. |
| `OIDC_ISSUER` | `https://login.microsoftonline.com/<tenant-id>/v2.0`, using the tenant **ID** and not a domain name, so it matches the discovery document's issuer exactly. |
| `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | The app registration's client ID and a client secret. Keep the secret in the deployment's secret store. |
| `AUTH_PASSWORD_ENABLED` | `false`. Required. |
| `MESSAGING_OPEN_SIGNUP` | Unset or `false`. Required. |
| `OIDC_ALLOW_SIGNUP_BYPASS` | `true`. Entra ID tokens carry no `email_verified` claim, so without it an allowlist would refuse every identity. The group is the admission decision. |
| `SIGNUPS_ENABLED` | `true`, with an empty `SIGNUP_ALLOWLIST`. Otherwise a group member who has never signed in is refused with `REGISTRATION_CLOSED`. Once an owner saves the signup policy in the app, the stored policy replaces these two values. |

The API refuses to start when `OIDC_REQUIRED_GROUP` is present and any of these hold:

- it is empty or blank;
- `OIDC_ISSUER`, `OIDC_CLIENT_ID` or `OIDC_CLIENT_SECRET` is missing;
- password authentication is not disabled;
- `MESSAGING_OPEN_SIGNUP=true`, which provisions accounts for chat senders outside OIDC.

A deployment that sets the variable therefore cannot start with the gate silently
off. The compose files in this repository do not pass it through: a `${VAR:-}` default
would render it blank, and blank is refused.

## What the gate enforces

- **Every OIDC callback is checked, not only the first.** Sign-in, account creation,
  account linking and the reauthentication used for account deletion all require the
  group. A user removed from the group is refused at their next sign-in.
- **The group comes from the verified ID token only.** The token's signature, issuer,
  audience and nonce are checked before its claims are read. Upstream falls back to the
  provider's userinfo endpoint when the token has no email; for Entra that endpoint is on
  Microsoft Graph and carries no groups. Under the gate there is no fallback. A token
  without an email claim is refused.
- **A group overage is refused.** When a user belongs to too many groups, Entra replaces
  `groups` with a pointer to Microsoft Graph (`_claim_names`, or `hasgroups` in implicit
  flows). The gate never calls Graph, so it refuses that token with
  `GROUP_CLAIM_OVERAGE` rather than guessing. Configure the app registration as below to
  avoid it.
- **No other way to get an account remains.** Password sign-in, sign-up and reset are
  refused server-side (upstream's `AUTH_PASSWORD_ENABLED=false`). Any account creation that
  is not a group-checked OIDC sign-in is refused with `REGISTRATION_CLOSED`.
- **Sessions do not extend themselves.** Upstream refreshes a session's expiry while it
  is used, so an active user would never sign in again and never be re-checked. Under the
  gate the refresh is off, and every session ends at its lifetime (Better Auth's default,
  seven days). That lifetime is the longest a removed member keeps access. The app has no
  control for ending another user's sessions; to end them at once, delete that user's rows
  from the `session` table.

Refusals redirect to the sign-in page with one of these codes. The page shows its
generic error text for them. No code names the configured group.

| Code | Meaning |
| --- | --- |
| `GROUP_NOT_ALLOWED` | The token lists groups and the configured group is not among them. |
| `GROUP_CLAIM_MISSING` | The token has no `groups` list. The app registration is not emitting groups. |
| `GROUP_CLAIM_OVERAGE` | The token points at Graph instead of listing groups. |

## Microsoft Entra ID setup

1. Register an application in the tenant. Add a **Web** redirect URI of
   `<BETTER_AUTH_URL>/api/auth/callback/oidc`. Create a client secret.
2. Under **Token configuration**, add a **groups claim** with **Groups assigned to the
   application**, emitted as **Group ID** in the ID token. With this setting the token lists
   only groups assigned to the application, which keeps it well under the overage limit.
   Add the optional `email` claim to the ID token.
3. In the matching enterprise application, set **Assignment required** to **Yes**, and
   assign the admin group. Entra then refuses everyone else before Rakazo sees them; the
   gate is the second check, not the only one.
4. Set `OIDC_REQUIRED_GROUP` to that group's object ID.

## Network egress

The API calls only the issuer's host, `login.microsoftonline.com`:

- the discovery document, at `<issuer>/.well-known/openid-configuration`;
- the token endpoint;
- the signing keys (JWKS).

The authorization endpoint is reached by the user's browser, not by the API. The gate
calls neither the userinfo endpoint nor Microsoft Graph, so an egress allowlist needs no
Graph entry for it.

## Where the patch touches upstream

- `packages/auth/src/oidc.ts`: the `requiredGroup` config field, an ID-token-only profile
  used when it is set, and `oidcGroupRefusal`.
- `packages/auth/src/index.ts`: the gate at the top of `validateUserInfo`, the startup check
  `assertGroupGateConfig`, and `disableSessionRefresh` under the gate.
- `apps/api/src/env.ts`: reading `OIDC_REQUIRED_GROUP` and its fail-closed checks.
- Tests: an `OIDC group gate` block appended to `packages/auth/src/oidc.test.ts`, and an
  `OIDC_REQUIRED_GROUP` block appended to `apps/api/src/env.test.ts`.

Only the `app` image changes. Rebase as described in
[fork-deployment-connectors.md](fork-deployment-connectors.md#rebasing-on-upstream); a
conflict in `validateUserInfo` is resolved by keeping upstream's body and re-adding the
fork's block above it.
