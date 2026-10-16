import { AsyncLocalStorage } from "node:async_hooks";
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";

type Fetch = typeof globalThis.fetch;

/** Fork: the transport for OIDC's server-side calls (discovery, JWKS, token
 * redemption) when the deployment routes egress through a proxy.
 *
 * Node's `NODE_USE_ENV_PROXY` works by installing an env-proxy dispatcher as
 * the global dispatcher, so anything that later calls
 * `setGlobalDispatcher(...)` (an SSRF guard, for example) silently takes every
 * global `fetch` off the proxy. On a host with no direct route out, discovery
 * then hangs until its timeout and sign-in reports SSO as unavailable. This
 * transport carries its own `EnvHttpProxyAgent`, so it does not depend on
 * whichever dispatcher is global. `NO_PROXY` is honoured.
 *
 * Returns `undefined` when no HTTPS proxy is configured, which keeps upstream
 * behaviour. See docs/fork-oidc-proxy.md. */
export function oidcProxyFetch(env: NodeJS.ProcessEnv = process.env): Fetch | undefined {
  const httpsProxy = env.https_proxy || env.HTTPS_PROXY;
  if (!httpsProxy) return undefined;
  const dispatcher = new EnvHttpProxyAgent({
    httpsProxy,
    httpProxy: env.http_proxy || env.HTTP_PROXY || "",
    noProxy: env.no_proxy ?? env.NO_PROXY ?? "",
  });
  return (async (input: Parameters<Fetch>[0], init?: Parameters<Fetch>[1]) => {
    // The package fetch is the one paired with the package Agent; Node's
    // bundled undici does not accept it as a dispatcher.
    const response = await undiciFetch(
      input as Parameters<typeof undiciFetch>[0],
      { ...init, dispatcher } as Parameters<typeof undiciFetch>[1],
    );
    // OIDC responses are small JSON documents. Buffer them into the global
    // `Response` so callers' `instanceof Response` checks still hold.
    const headers = new Headers();
    response.headers.forEach((value, key) => {
      if (!REWRITTEN_HEADERS.has(key.toLowerCase())) headers.append(key, value);
    });
    const body = NULL_BODY_STATUSES.has(response.status) ? null : await response.arrayBuffer();
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }) as Fetch;
}

/** The body is re-buffered after undici decoded it, so its framing headers no
 * longer describe it. */
const REWRITTEN_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "transfer-encoding",
]);
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

const scope = new AsyncLocalStorage<Fetch>();
let unscoped: Fetch | undefined;
const scopedFetch = ((input: Parameters<Fetch>[0], init?: Parameters<Fetch>[1]) =>
  (scope.getStore() ?? unscoped!)(input, init)) as Fetch;

/** Run `operation` with `transport` as the fetch for every call it makes.
 *
 * The auth library and its JWT verifier read `globalThis.fetch` at call time
 * and take no fetch of their own, so the global is wrapped once and the
 * wrapper defers to whatever was installed before it. Only calls made inside
 * `operation`'s async context see `transport`; every other fetch in the
 * process is unchanged. If the global has been replaced since, the
 * replacement is wrapped instead. */
export function withOidcTransport<T>(
  transport: Fetch | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (!transport) return operation();
  if (globalThis.fetch !== scopedFetch) {
    unscoped = globalThis.fetch;
    globalThis.fetch = scopedFetch;
  }
  return scope.run(transport, operation);
}
