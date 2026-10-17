# Fork patch set: trusted access identity

This fork can hand authentication to an access proxy in front of the server, such as
Cloudflare Access. The proxy signs the user in against the organisation's identity
provider and applies the admission policy (group, MFA). On every request it forwards a
signed assertion in the `Cf-Access-Jwt-Assertion` header. Rakazo verifies that
assertion and does no sign-in of its own. Nothing changes unless
`ACCESS_IDENTITY_ENABLED=true`. An unconfigured instance behaves exactly like upstream.

## Configuration

Set these on the API. The worker does not authenticate users and does not read them.

| Variable | Value |
| --- | --- |
| `ACCESS_IDENTITY_ENABLED` | `true` turns the mode on. `false` or unset leaves it off. |
| `ACCESS_IDENTITY_ISSUER` | The assertion's `iss`: the access team's HTTPS origin, for example `https://<team>.cloudflareaccess.com`. A trailing `/` is dropped; a path, query or credentials are refused. |
| `ACCESS_IDENTITY_AUDIENCE` | The access application's audience (AUD) tag. The assertion's `aud` must contain it. |
| `ACCESS_IDENTITY_CERTS_FILE` | A path to the signing keys, written by the host: a JWKS, or the proxy's `certs` document, which has the same `keys` array. |

The API refuses to start when the mode is on and any of these hold:

- the issuer, audience or certs file is missing, or the issuer is not an HTTPS origin;
- `AUTH_PASSWORD_ENABLED=true`. Unset is fine: the mode turns password auth off;
- OIDC is configured: `OIDC_ISSUER`, `OIDC_CLIENT_ID` or `OIDC_CLIENT_SECRET` is non-blank,
  or `OIDC_REQUIRED_GROUP` is set;
- `MESSAGING_OPEN_SIGNUP=true`, which provisions accounts for chat senders.

`OIDC_NAME`, `OIDC_SCOPES` and `OIDC_ALLOW_SIGNUP_BYPASS` configure nothing without an
issuer, so their compose defaults are ignored. The compose files default
`AUTH_PASSWORD_ENABLED` to `true`, so a compose deployment sets it to `false`. The compose
files do not pass the `ACCESS_IDENTITY_*` variables through; the deployment adds them.

## What the mode enforces

- **Every request is verified.** Each API request must carry an assertion that passes
  all of these checks:
  - an RS256 signature by a key in the certs file, selected by `kid`;
  - `iss` equal to the issuer;
  - `aud` containing the audience;
  - `exp` in the future and `nbf`, when present, in the past. Both allow 60 seconds of
    clock skew;
  - non-empty `email` and `sub` claims.

  Anything else gets `401` with code `ACCESS_IDENTITY_REQUIRED`. That covers a missing,
  malformed, expired or wrongly signed assertion, an unknown `kid`, an algorithm other
  than RS256, and certs that cannot be read. Service-token assertions carry no `email`
  and are refused too. Identity headers that are not the signed assertion, such as
  `Cf-Access-Authenticated-User-Email` or any `X-Forwarded-*` header, are never read.
- **Exempt routes.** Five routes need no assertion:
  - `/health` and `/ready`, the liveness and readiness probes;
  - `/internal/health`, which already refuses anything that came through a proxy;
  - `/api/auth/capabilities`, which says only that this mode is on;
  - `/api/internal/screen-target`, which the web server calls server to server with its
    own bearer secret.

  Every other route is closed without an assertion, including inbound webhooks.
- **The certs file is reloaded when it changes.** A change is detected by mtime and size,
  checked on each request. A file that cannot be read or parsed, or that holds no usable
  RSA signing key, keeps the last good set. Until a good set has been loaded once, every
  assertion is refused.
- **Accounts are linked to the subject, not the email.** On first sign-in the web app
  posts to `/api/auth/access-identity/sign-in`. The endpoint verifies the assertion and
  looks up the account linked to its issuer and `sub`. The link is an `account` row with
  `providerId = 'access-identity'` and `accountId = '<issuer> <sub>'`.
  - **Linked:** the account signs in. If the assertion's email has changed, the account's
    email follows it, unless another account already holds that email
    (`ACCESS_IDENTITY_EMAIL_IN_USE`).
  - **Not linked:** an existing account with the same email (lower-cased) is linked to the
    subject, once. If there is none, an account is created with the email marked verified,
    and linked.
  - **Refused, never merged:** an account whose email matches but which is already linked
    to a different subject (`ACCESS_IDENTITY_SUBJECT_MISMATCH`). That is what a reassigned
    email looks like, since the proxy issues a new `sub` when an identity is removed and
    re-added. An admin re-links deliberately: delete that account's `access-identity` row,
    and the next sign-in links by email.

  Then the endpoint issues Rakazo's normal session cookie. The signup policy
  (`SIGNUPS_ENABLED`, the allowlist, a stored policy) does not apply: the access policy is
  the admission decision. No other path creates an account or a session in this mode, and
  `/unlink-account` is closed.
- **Sessions are bound to the subject.** A session counts only beside a valid assertion
  whose subject is the one the session's user is linked to. Any other subject ends that
  session, and so does a user with no link. A session cookie or bearer token with no valid
  assertion is refused. Because the assertion is re-checked on every request, sessions
  refresh as they do upstream.
- **Account deletion re-authenticates with a fresh assertion.** `/delete-user` accepts an
  assertion for the account's own linked subject whose `iat` is under five minutes old.
  `/account-security` then reports `freshOidcAuth: true`, which enables the web app's Delete
  account control. The proxy sets `iat` when it authenticates the user, so an older Access
  session has to sign in to the proxy again before deleting. Without a fresh, matching
  assertion, deletion is refused.
- **Other ways in are closed.** These auth routes answer `403` with code
  `ACCESS_IDENTITY_ONLY`:
  - password sign-in, sign-up, reset and change;
  - social and OAuth/OIDC sign-in, callbacks and account linking;
  - magic links and email OTP;
  - email change and email verification.

  The sign-in page shows no form. It exchanges the assertion for a session. A refusal
  (401 or 403) shows "Sign in through your organisation's portal". A network failure or
  server error shows "Could not reach the server" with a Retry control.
- **The mobile app does not sign in.** Its sign-in screen shows "This server uses your
  organisation's sign-in in a web browser" instead of a form.
- **Logout** clears the Rakazo session only. The access proxy's own session continues, so
  the next visit signs straight back in. To end access, remove the user in the access
  policy or end their session at the proxy.

## Deployment requirement

**The origin must be reachable only through the access proxy.** Verifying the assertion is
the control: the origin cannot be signed into without a valid assertion, whoever can reach
it. Network isolation is defence in depth on top of that. For example, use an outbound
tunnel and no public listener, and do not expose the API port to agent computers or other
hosts. A host process that can reach the API port is still refused without a valid
assertion.

The host must keep `ACCESS_IDENTITY_CERTS_FILE` current with the proxy's published signing
keys. The proxy rotates its keys, and an assertion signed with a key that is not in the
file is refused.

## Where the patch touches upstream

- New, fork-owned:
  - `packages/auth/src/access-identity.ts`, the verifier and the sign-in endpoint;
  - `apps/api/src/access-identity.ts`, the request gate and the session binding;
  - `apps/web/src/lib/access-identity.ts`;
  - `packages/db/prisma/migrations/20261016120000_fork_access_identity_subject_unique`, a
    partial unique index on access-identity links. Overlapping first sign-ins for one
    subject are settled by it: the request that loses the insert removes the user it just
    created and resolves to the winner's link, so no lock holds a database connection. It
    is deliberately absent from `schema.prisma`, so `prisma migrate dev` reports it as drift;
  - the matching `*.test.ts` files.
- `packages/auth/src/index.ts`:
  - the `accessIdentity` option and `assertAccessIdentityConfig`;
  - the closed-path check in the `before` hook;
  - the `validateUserInfo` and `user.create` refusals;
  - the session `create` hook's access branch.
- `apps/api/src/app.ts`: building the verifier, mounting the gate, binding sessions in
  `requestSession` and on `/api/auth/*`, and the `accessIdentity` capability.
- `apps/api/src/env.ts`: `accessIdentityFromEnv` and its fail-closed checks.
- `packages/contracts/src/auth.ts`: the optional `accessIdentity` capability.
- `packages/auth/src/account-security.ts`: an optional fresh re-authentication check, used
  by `/account-security` and the `/delete-user` hook.
- `apps/web/src/pages/Auth.tsx`: the access branch of the sign-in page.
- `apps/mobile/app/sign-in.tsx` and its `de`, `ru` and `zh` catalogs: the browser-only
  message.
- `apps/desktop/src/setup-config.ts` and `main.ts`: setup refuses an access-identity server
  with the same browser-only message.
- `apps/api/src/health.ts`: an optional readiness check; `/ready` is 503 until a usable
  key set has loaded.
- Tests: an `ACCESS_IDENTITY_ENABLED` block appended to `apps/api/src/env.test.ts`, and
  access blocks appended to `apps/web/src/pages/Auth.test.tsx` and
  `apps/mobile/lib/sign-in.test.tsx`.

Only the `app` image changes, plus the one migration it runs at startup.
