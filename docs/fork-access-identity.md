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
- any `OIDC_*` variable has a non-blank value, including the OIDC group gate;
- `MESSAGING_OPEN_SIGNUP=true`, which provisions accounts for chat senders.

The compose files in this repository default `AUTH_PASSWORD_ENABLED` to `true` and
`OIDC_NAME`, `OIDC_SCOPES` and `OIDC_ALLOW_SIGNUP_BYPASS` to non-blank values, so a
compose deployment has to override them to blank (and `AUTH_PASSWORD_ENABLED` to `false`
or blank) before the mode will start.

## What the mode enforces

- **Every request is verified.** Each API request must carry an assertion that passes
  all of these checks:
  - an RS256 signature by a key in the certs file, selected by `kid`;
  - `iss` equal to the issuer;
  - `aud` containing the audience;
  - `exp` in the future and `nbf`, when present, in the past. Both allow 60 seconds of
    clock skew;
  - a non-empty `email` claim.

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
- **Accounts come only from a verified assertion.** On first sign-in the web app posts to
  `/api/auth/access-identity/sign-in`. The endpoint verifies the assertion, finds the user
  by its email (lower-cased), and creates the user if there is none, with the email
  marked verified. Then it issues Rakazo's normal session cookie. The signup policy
  (`SIGNUPS_ENABLED`, the allowlist, a stored policy) does not apply: the access policy is
  the admission decision. No other path creates an account or a session in this mode.
- **Sessions are bound to the access identity.** A session counts only beside a valid
  assertion for the same email. A request whose verified email differs from the session's
  user ends that session. A session cookie or bearer token with no valid assertion is
  refused. Because the assertion is re-checked on every request, sessions refresh as they
  do upstream.
- **Other ways in are closed.** These auth routes answer `403` with code
  `ACCESS_IDENTITY_ONLY`:
  - password sign-in, sign-up, reset and change;
  - social and OAuth/OIDC sign-in, callbacks and account linking;
  - magic links and email OTP;
  - email change and email verification.

  The sign-in page shows no form. It exchanges the assertion for a session and, if that
  is refused, shows "Sign in through your organisation's portal".
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
- `apps/web/src/pages/Auth.tsx`: the access branch of the sign-in page.
- Tests: an `ACCESS_IDENTITY_ENABLED` block appended to `apps/api/src/env.test.ts` and an
  access block appended to `apps/web/src/pages/Auth.test.tsx`.

Only the `app` image changes.
