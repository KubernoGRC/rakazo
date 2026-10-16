# Fork patch set: OIDC through an egress proxy

On a host whose only way out is an HTTP proxy, the API reaches the OpenID Connect
provider through that proxy whatever else has changed Node's global dispatcher.
Nothing changes unless `HTTPS_PROXY` (or `https_proxy`) is set. An instance without
one behaves exactly like upstream.

## Why it is needed

Node's `NODE_USE_ENV_PROXY=1` sends global `fetch` through the proxy by installing an
env-proxy dispatcher as undici's **global dispatcher**. Any library that later calls
`setGlobalDispatcher(...)` replaces it. An SSRF guard that pins connections does
exactly that, and from then on every global `fetch` in the process goes direct. With
no direct route, issuer discovery hangs until its 8 second timeout and sign-in fails
with "SSO is temporarily unavailable". A fresh process still works, which makes the
fault easy to misread as the proxy or the IdP.

## What the fork does

`packages/auth/src/oidc-transport.ts` builds a fetch on undici's `EnvHttpProxyAgent`,
reading `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` (either case). `oidcDiscovery` runs
every call that leaves the process for the IdP on it:

- issuer discovery (`/.well-known/openid-configuration`);
- authorization-code redemption and token refresh;
- the JWKS fetch made while verifying the ID token.

The auth library and its JWT verifier read `globalThis.fetch` when they call it and do
not accept a fetch of their own. So the global is wrapped once, and the wrapper hands
a call to the proxy transport only inside the OIDC operation's async context
(`AsyncLocalStorage`). Every other fetch in the process, including the guarded ones,
is untouched. The SSRF guard is not disabled.

## Limits

- Only the OIDC provider's server-side calls are covered. Other outbound calls that
  depended on `NODE_USE_ENV_PROXY` are still subject to the global dispatcher.
- If some other code replaces `globalThis.fetch` (rather than the dispatcher) after
  the wrap, the next OIDC operation wraps the replacement. A call already in flight
  keeps the fetch it started with.
