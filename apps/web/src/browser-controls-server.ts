// Fork: origin headers for the served web UI; see docs/fork-browser-controls.md.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";

const INLINE_SCRIPT = /<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;

/** CSP hash sources for every inline `<script>` in the built index.html. */
export function inlineScriptHashes(html: string): string[] {
  const hashes = new Set<string>();
  for (const match of html.matchAll(INLINE_SCRIPT)) {
    const body = match[1] ?? "";
    if (!body.trim()) continue;
    hashes.add(`'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`);
  }
  return [...hashes];
}

/**
 * The page's Content-Security-Policy. Every fetch destination is this origin; nothing names
 * another host or a scheme wildcard.
 *
 * - `img-src` adds `data:` and `blob:`. Both are local (an attachment preview's object URL, an
 *   inline SVG in the stylesheet) and neither can make a network request.
 * - `media-src` adds `blob:` for the same reason.
 * - `style-src` allows inline style elements, which UI libraries inject at runtime (scroll lock,
 *   toasts). An inline style can only reach the network through `url()`, and that is governed by
 *   `img-src` and `font-src`, so it cannot widen egress.
 * - `connect-src 'self'` covers the app's own WebSocket origin.
 * - `frame-src 'none'`: no embedded content at all, so the screen, PDF and HTML viewers are
 *   replaced by placeholders (src/lib/browser-controls.ts).
 */
export function contentSecurityPolicy(scriptHashes: readonly string[]): string {
  return [
    "default-src 'self'",
    ["script-src 'self'", ...scriptHashes].join(" "),
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "connect-src 'self'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "object-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function browserControlHeaders(scriptHashes: readonly string[]): Record<string, string> {
  return {
    "content-security-policy": contentSecurityPolicy(scriptHashes),
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    // No speculative DNS lookups for hosts named in links a message rendered.
    "x-dns-prefetch-control": "off",
  };
}

const STRIPPED = ["expires", "etag", "last-modified"];
const CSP = "content-security-policy";

/**
 * Responses that keep their own CSP and get no page policy: the computer screen proxy. Its
 * upstream policy sandboxes the screen into an opaque origin, which is what keeps it from the
 * app's cookies and storage, and in an opaque origin `script-src 'self'` matches nothing, so the
 * page policy would only break it. It is no chat page, and with `frame-src 'none'` the UI never
 * embeds it. It still gets no-store and no-referrer.
 */
const OWN_POLICY_PREFIXES = ["/novnc/"];

/**
 * A response that brings its own CSP keeps it, and ours is added as a second policy. Browsers
 * enforce every policy they are given, so the result is never weaker than either. The screen
 * proxy relies on this: its `sandbox` policy is what isolates a computer's screen from the app.
 */
function withOwnPolicy(existing: OutgoingHttpHeaders[string], ours: string): string | string[] {
  const prior = (
    Array.isArray(existing) ? existing : existing == null ? [] : [String(existing)]
  ).filter((value) => value !== ours);
  return prior.length ? [...prior, ours] : ours;
}

function overlay(headers: OutgoingHttpHeaders, forced: Record<string, string>) {
  const next: OutgoingHttpHeaders = {};
  let ownPolicy: OutgoingHttpHeaders[string];
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === CSP) ownPolicy = value;
    else if (!(lower in forced) && !STRIPPED.includes(lower)) next[name] = value;
  }
  const ours = forced[CSP];
  if (ours === undefined)
    return ownPolicy === undefined
      ? { ...next, ...forced }
      : { ...next, ...forced, [CSP]: ownPolicy };
  return { ...next, ...forced, [CSP]: withOwnPolicy(ownPolicy, ours) };
}

/**
 * Forces the headers onto every response, whatever writes it: static files, the SPA fallback,
 * and the `/api` and `/rpc` proxies. Set at `writeHead`, so a later `setHeader` from the static
 * server or a proxied response cannot replace them.
 */
export function forceBrowserControlHeaders(
  getScriptHashes: () => readonly string[],
): (req: IncomingMessage, res: ServerResponse, next: () => void) => void {
  return (req, res, next) => {
    const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => ServerResponse;
    const ownPolicyOnly = OWN_POLICY_PREFIXES.some((prefix) => req.url?.startsWith(prefix));
    const forced = () => {
      const headers = browserControlHeaders(getScriptHashes());
      if (ownPolicyOnly) delete headers[CSP];
      return headers;
    };
    const apply = () => {
      const headers = forced();
      for (const name of STRIPPED) res.removeHeader(name);
      for (const [name, value] of Object.entries(headers)) {
        res.setHeader(name, name === CSP ? withOwnPolicy(res.getHeader(CSP), value) : value);
      }
    };
    (res as { writeHead: unknown }).writeHead = (...args: unknown[]) => {
      apply();
      // writeHead(status, [message], [headers]): headers passed here win over setHeader.
      const last = args.length - 1;
      if (last >= 1 && args[last] && typeof args[last] === "object" && !Array.isArray(args[last])) {
        args[last] = overlay(args[last] as OutgoingHttpHeaders, forced());
      }
      return writeHead(...args);
    };
    next();
  };
}

/**
 * The inline-script hashes of the built page. Without a built index.html there is no inline
 * script to allow, so none is: the policy fails closed rather than refusing to start.
 */
export function builtScriptHashes(indexHtmlPath: string): string[] {
  try {
    return inlineScriptHashes(readFileSync(indexHtmlPath, "utf8"));
  } catch {
    return [];
  }
}
