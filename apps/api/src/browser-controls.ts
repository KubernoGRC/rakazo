// Fork: browser retention controls; see docs/fork-browser-controls.md.
import type { FaviconResolver } from "@rakazo/adapters";
import type { MiddlewareHandler } from "hono";

/**
 * Headers every API response carries, whatever produced it: a handler, a gate's 401, a body
 * limit's 413, or the default error handler's 500. An error can echo the content it failed on,
 * so the rule is "every response", not "every successful chat response".
 */
export const BROWSER_CONTROL_HEADERS: Readonly<Record<string, string>> = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

export const SIGN_OUT_PATH = "/api/auth/sign-out";

/**
 * On sign-out the browser drops the origin's HTTP cache and every storage interface. The app
 * clears its own state too (apps/web/src/lib/browser-controls.ts); this covers a browser whose
 * page never ran that code, and a store the app does not know about.
 */
export const SIGN_OUT_CLEAR_SITE_DATA = '"cache", "storage"';

function applyHeaders(headers: Headers) {
  for (const [name, value] of Object.entries(BROWSER_CONTROL_HEADERS)) headers.set(name, value);
  headers.delete("expires");
  headers.delete("etag");
  headers.delete("last-modified");
}

/**
 * Mounted first so it wraps everything else. It runs after `next()`, so a handler that set its
 * own `cache-control` (an attachment download's `private, max-age=…`, say) is overridden.
 */
export function browserControlHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const signOut = new URL(c.req.url).pathname === SIGN_OUT_PATH;
    const apply = (headers: Headers) => {
      applyHeaders(headers);
      if (signOut) headers.set("clear-site-data", SIGN_OUT_CLEAR_SITE_DATA);
    };
    try {
      apply(c.res.headers);
    } catch {
      // A Response passed through from fetch() has immutable headers. Copy it, then set them.
      const copy = new Response(c.res.body, c.res);
      apply(copy.headers);
      c.res = copy;
    }
  };
}

/**
 * Link icons are fetched by the API from the linked site, which makes every rendered link a
 * server-side request to a URL a message chose. Chat rendering must make no request a reader did
 * not ask for, so the resolver answers "no icon" without looking.
 */
export const noLinkFavicons: FaviconResolver = {
  favicon: async () => ({ icon: null }),
};
