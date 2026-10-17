# Fork patch set: browser controls

Staff browsers receive conversation content, and a browser can keep it after the server has
purged it. Chat rendering can also make requests nobody asked for: an image URL in a reply can
carry conversation data to any host the moment it renders. This patch set closes both, at the
origin. The headers are set by the API and by the web server itself, not by a proxy in front,
so they hold on every path to the UI, a port forward included.

Source: §1.1 of the Rakazo internal admin agent
design ("Staff browsers receive content and can retain it", "Chat rendering must not make
unsolicited outbound requests").

## What it does

### Responses are never stored

- **API** (`apps/api/src/browser-controls.ts`): the first middleware sets `Cache-Control:
  no-store`, `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff` on **every**
  response. It also strips `ETag`, `Last-Modified` and `Expires`. That covers handlers, gates'
  401s, body-limit 413s and the default error handler's 500, because an error can echo the
  content it failed on. It runs after the handler, so a route that set its own caching header
  is overridden.
- **Sign-out** answers `Clear-Site-Data: "cache", "storage"` as well.
- **Web server** (`apps/web/src/browser-controls-server.ts`, the `kgrc-browser-controls`
  plugin in `vite.config.ts`): `vite preview` forces the same headers onto everything it
  answers, including the `/api` and `/rpc` proxies and the proxies' own 502s. They are set at
  `writeHead`, so neither the static server nor a proxied response can replace them.

### Origin Content-Security-Policy

`vite preview` sends this on every response:

```
default-src 'self'; script-src 'self' 'sha256-…'; style-src 'self' 'unsafe-inline';
font-src 'self'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:;
object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'self'; manifest-src 'self';
base-uri 'none'; form-action 'self'; frame-ancestors 'none'
```

- **No other host, no scheme wildcard.** `connect-src 'self'` includes the app's own WebSocket
  origin.
- **`script-src` hashes** the inline theme bootstrap in `index.html`. The hash is computed from
  the **built** `index.html` when the server starts, so editing that script can't leave a stale,
  hand-kept hash behind.
- **`img-src` adds `data:` and `blob:`, `media-src` adds `blob:`.** These are local: an
  attachment preview's object URL, or an inline image. Neither can make a network request. The
  design text says `img-src 'self'`, and this is the deliberate, egress-neutral widening of it.
- **`style-src` allows inline style elements.** UI libraries inject them at runtime (scroll
  lock, toasts). An inline style reaches the network only through `url()`, which `img-src` and
  `font-src` govern, so it can't widen egress.
- **`frame-src 'none'`** means no embedded document of any kind. See "What staff lose" below.
- **A response's own CSP is kept** and ours is added as a second policy. Browsers enforce every
  policy, so the result is never weaker than either.
- **The screen proxy (`/novnc/`) is the one exemption.** It keeps only upstream's own policy,
  plus `no-store` and `no-referrer`. That policy sandboxes the screen into an opaque origin,
  which is what keeps it away from the app's cookies and storage. In an opaque origin
  `script-src 'self'` matches nothing, so the page policy would only break it. It is not a chat
  page, and under `frame-src 'none'` the UI never embeds it.
- **Without a built `index.html`** there is no inline script to allow, so the policy allows
  none. It fails closed rather than refusing to start.

`vite dev` doesn't get the CSP, because Vite's dev client needs inline scripts. The deployment
runs `vite preview`.

### Chat rendering makes no request of its own

- **Remote Markdown images are inert text** (`packages/chat-ui/src/markdown.web.tsx`): an
  image icon, the alt text and the host, with nothing to press. Upstream drew a button that
  loaded the image on a tap, plus a setting that loaded them all. Neither does anything here.
  Embedded `data:image/…` rasters still render, since they make no request.
- **Raw HTML** in Markdown is skipped, as upstream already does (`skipHtml`). So a raw `<img>`,
  `<video>` or `<audio>` in a reply renders as nothing.
- **Link icons are off** at both ends. The web app provides no favicon source, and the API's
  resolver answers "no icon" without fetching (`noLinkFavicons`). Upstream's resolver fetched
  the linked site **from the server**, which is a server-side request to a URL that a message
  chose.
- **Links** keep upstream's confirmation before leaving the app, with `rel="noreferrer
  noopener"`. They are never prefetched, and the web server sends `X-DNS-Prefetch-Control:
  off`. Following one is a user-directed disclosure. That disclosure is a staff-handling
  residual, not something the app can prevent.

### No chat content in browser storage

All of this is in `apps/web/src/lib/browser-controls.ts`.

- **Storage guard.** Upstream writes some chat content to `localStorage`, such as composer
  drafts, and may add more. So the guard works by allowlist. Only listed **preference** keys
  (theme, locale, panel widths, the selected space id, collapsed sections, the ids of run
  errors already shown) reach persistent storage. Every other `Storage` write is kept in page memory: reads still see it, so a draft
  survives switching threads, but a reload, a logout or a closed tab drops it.
  `sessionStorage` admits one key, the one-shot preload-recovery flag. Page-memory copies
  are not listed by `key()` or `length`, so code that enumerates storage sees only the
  persisted keys.
- **Every page load** sweeps every non-preference `localStorage` key and `sessionStorage`. It
  also deletes every IndexedDB database and every Cache Storage cache, and unregisters any
  service worker. This is the cutover invalidation for a profile an older build wrote to, and it
  keeps running afterwards.
- **Session end.** When the session gate goes from signed in to signed out (logout, expiry or
  revocation), the app clears all of the above, **preferences included**, then replaces the
  document. A fresh page is the only way to be sure no component, query cache or module-level
  map still holds the conversation. A cold load that starts signed out doesn't trigger this.
- **Back/forward cache.** A page restored from it (`pageshow` with `persisted`) reloads, so it
  can't show a conversation frozen from before the session ended. The `no-store` document
  already keeps most browsers from caching it at all.

## What staff lose

`frame-src 'none'` and "no active embedded content" mean three upstream surfaces show a
placeholder ("Embedded previews are turned off in this deployment") instead of an iframe:

- **The computer screen**, both in the side panel and in the full workspace view;
- **PDF artifact previews**;
- **HTML artifact previews**, which upstream already sandboxed.

Downloads of the same artifacts still work. `EMBEDDED_FRAMES_ENABLED` in `browser-controls.ts`
is the single switch. Turning it back on also needs `frame-src` widened in
`browser-controls-server.ts` (`'self'` for the screen proxy, `blob:` for PDFs), and that is a
change to the A3 design, not to this file.

Upstream e2e specs of the embedded screen are **skipped**, not deleted, using the reason in
`apps/web/e2e/fork-screen-disabled.ts`. That keeps them visible across upstream merges.
Affected: `computer-screen-error`, two `team-computer` tests, `teach-task`, and the preview-mode
iframe tests in `screen-proxy-isolation`.

Upstream tests changed to match:

- **Remote images**: `markdown-images.spec.ts`, `markdown.web.test.tsx` and
  `chat-markdown.test.tsx` now assert inert text where they asserted tap-to-load.
- **Link icons**: `link-favicons.spec.ts` now asserts a globe and no lookup.
- **Drafts**: `composer-enter-preference.spec.ts` no longer expects a draft to survive a
  reload.

## Tests

- **`apps/api/src/browser-controls.test.ts`**: every response is `no-store`, including errors,
  404s, handler overrides and immutable-header responses, and sign-out clears site data.
- **`apps/web/src/browser-controls-server.test.ts`**:
  - each CSP directive, and that no directive names a host;
  - the inline-script hashes, including the real `index.html`;
  - that the headers survive both `setHeader` and `writeHead(…, headers)`.
- **`apps/web/src/lib/browser-controls.test.ts`**: the guard, the allowlist, the load and
  session-end purges, the IndexedDB, cache and service-worker deletion, the session transition
  and the bfcache reload.
- **`apps/web/e2e/browser-controls.spec.ts`**, the browser canaries:
  - **Egress.** A reply contains an attacker-URL Markdown image, a raw HTML image, video and
    audio elements, and linked and bare previewable links. The test scrolls and hovers. A
    **real** canary server must see zero requests, the page must make no request to any other
    origin, and nothing may ask for a link icon.
  - **Storage.** A chat canary and an unsent draft go through reload, logout, back navigation,
    offline navigation and session expiry. No store may hold the canary (`localStorage`,
    `sessionStorage`, IndexedDB, Cache Storage), stale chat must not render, and every `/api`
    and `/rpc` response must be `no-store`.
  - **Upgrade.** A profile seeded the way an older build wrote it (a draft, the remote-image
    setting, an IndexedDB database and a Cache Storage entry holding the canary) is swept on
    first load, and its preference survives.

  These specs run against `vite dev`, which has no CSP, so they prove that the DOM is inert on
  its own. The CSP is the second, independent layer, and the server test covers it.
