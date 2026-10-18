// Fork: browser retention controls; see docs/fork-browser-controls.md.
//
// Chat content must not outlive the server's copy in a staff browser. Upstream persists some of
// it (composer drafts in localStorage) and may add more, so this module does not hunt for those
// keys. It enforces the converse: only listed PREFERENCES ever reach persistent storage, and
// anything else written through the Storage API lives in page memory and dies with the page.

/** Exact localStorage keys that hold a UI preference or an id, never message content. */
const PREFERENCE_KEYS: ReadonlySet<string> = new Set([
  "rakazo.uiAppearance",
  "rakazo.uiLocale",
  "rakazo.showToolActivity",
  "rakazo.responseStreaming",
  "rakazo.botsSidebarDensity",
  "rakazo.composerEnterToSend",
  "rakazo.activity-mode",
  "rakazo:space-id",
  "rakazo:right-panel-width",
  "rakazo:artifacts-view-mode",
]);

/** Prefixes of localStorage keys whose names and values are ids, panel names, flags or times. */
const PREFERENCE_PREFIXES: readonly string[] = [
  "rakazo:bots-sidebar-collapsed:",
  // A run id → when its error was shown, so a seen error does not return after a reload.
  "rakazo:seen-run-error:",
  "rakazo:right-panel-state:",
  "rakazo:collapsed-sidebar-sections:",
  "rakazo:collapsed-roster-parents:",
];

/** sessionStorage keys allowed to persist: a one-shot reload guard holding "1". */
const SESSION_KEYS: ReadonlySet<string> = new Set(["rk:preload-recovery"]);

export function isPreferenceKey(key: string): boolean {
  return PREFERENCE_KEYS.has(key) || PREFERENCE_PREFIXES.some((prefix) => key.startsWith(prefix));
}

type StorageKind = "local" | "session";

function kindOf(target: Storage): StorageKind | null {
  try {
    if (target === window.localStorage) return "local";
  } catch {}
  try {
    if (target === window.sessionStorage) return "session";
  } catch {}
  return null;
}

function persists(kind: StorageKind, key: string): boolean {
  return kind === "local" ? isPreferenceKey(key) : SESSION_KEYS.has(key);
}

const memory: Record<StorageKind, Map<string, string>> = { local: new Map(), session: new Map() };
let guarded = false;

/**
 * Routes every Storage write that is not a listed preference to page memory. Reads see the
 * memory copy, so in-page behaviour (a draft kept while switching threads) is unchanged; a
 * reload, a logout or a closed tab drops it.
 */
export function installStorageGuard(proto: Storage = Storage.prototype): void {
  if (guarded) return;
  guarded = true;
  const { getItem, setItem, removeItem, clear } = proto;
  proto.setItem = function (this: Storage, key: string, value: string) {
    const kind = kindOf(this);
    if (!kind || persists(kind, String(key))) return setItem.call(this, key, value);
    memory[kind].set(String(key), String(value));
  };
  proto.getItem = function (this: Storage, key: string) {
    const kind = kindOf(this);
    if (!kind || persists(kind, String(key))) return getItem.call(this, key);
    return memory[kind].get(String(key)) ?? null;
  };
  proto.removeItem = function (this: Storage, key: string) {
    const kind = kindOf(this);
    if (kind) memory[kind].delete(String(key));
    return removeItem.call(this, key);
  };
  proto.clear = function (this: Storage) {
    const kind = kindOf(this);
    if (kind) memory[kind].clear();
    return clear.call(this);
  };
}

function sweep(storage: Storage | null, keep: (key: string) => boolean) {
  if (!storage) return;
  const doomed: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key !== null && !keep(key)) doomed.push(key);
  }
  for (const key of doomed) storage.removeItem(key);
}

function storageOrNull(kind: StorageKind): Storage | null {
  try {
    return kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Deletes what this origin keeps in the browser beyond the cookie: every non-preference
 * localStorage key (all of them with `preferences: false`), sessionStorage, IndexedDB, Cache
 * Storage and any service worker. Run at every page load, which is also the cutover
 * invalidation for a profile that ran an older build, and at the end of every session.
 */
/**
 * How long a purge waits for an IndexedDB delete that another tab is blocking. The delete stays
 * queued and completes when that tab closes or reloads; on sign-out the server's Clear-Site-Data
 * covers it too. Bounded so a session end can never hang on another tab.
 */
export const INDEXED_DB_DELETE_WAIT_MS = 3_000;

/** Resolves once the delete succeeded or failed, or after the bound while it is blocked. */
function deleteDatabase(name: string, waitMs: number): Promise<void> {
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest | undefined;
    try {
      request = indexedDB.deleteDatabase(name);
    } catch {
      resolve();
      return;
    }
    if (!request) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, waitMs);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    request.onsuccess = done;
    request.onerror = done;
  });
}

export async function purgeBrowserState({
  preferences,
  indexedDbWaitMs = INDEXED_DB_DELETE_WAIT_MS,
}: {
  preferences: boolean;
  indexedDbWaitMs?: number;
}): Promise<void> {
  memory.local.clear();
  memory.session.clear();
  try {
    sweep(storageOrNull("local"), preferences ? isPreferenceKey : () => false);
  } catch {}
  try {
    sweep(storageOrNull("session"), (key) => SESSION_KEYS.has(key));
  } catch {}
  await Promise.allSettled([
    (async () => {
      if (typeof indexedDB === "undefined" || typeof indexedDB.databases !== "function") return;
      const names = (await indexedDB.databases()).flatMap(({ name }) => (name ? [name] : []));
      await Promise.all(names.map((name) => deleteDatabase(name, indexedDbWaitMs)));
    })(),
    (async () => {
      if (typeof caches === "undefined") return;
      for (const name of await caches.keys()) await caches.delete(name);
    })(),
    (async () => {
      if (typeof navigator === "undefined" || !navigator.serviceWorker) return;
      for (const registration of await navigator.serviceWorker.getRegistrations()) {
        await registration.unregister();
      }
    })(),
  ]);
}

let ending = false;

/**
 * A session ended (sign-out, expiry, revocation). Clear storage, preferences included, then
 * replace the document: a fresh page is the only way to be sure no component, query cache or
 * module-level map still holds the conversation. It reloads wherever the signed-out app has
 * already routed to (sign-in, usually), so the landing is upstream's.
 */
export async function endBrowserSession(
  target: Pick<Location, "replace" | "href"> = window.location,
) {
  if (ending) return;
  ending = true;
  await purgeBrowserState({ preferences: false });
  target.replace(target.href);
}

/**
 * Tracks the session gate. Only a transition from signed in to signed out ends the session, so a
 * cold load that starts signed out does not loop.
 */
export function watchSessionEnd(
  end: () => Promise<void> = () => endBrowserSession(),
): (gate: string) => void {
  let wasAuthenticated = false;
  return (gate) => {
    if (gate === "authenticated") wasAuthenticated = true;
    else if (gate === "anonymous" && wasAuthenticated) void end();
  };
}

/**
 * Back/forward cache: a page restored from it was frozen with whatever it showed, possibly after
 * the session ended. Reload it so it renders from the server's current answer.
 */
export function reloadRestoredPages(target: Window = window): void {
  target.addEventListener("pageshow", (event) => {
    if ((event as PageTransitionEvent).persisted) target.location.reload();
  });
}

/**
 * Embedded documents of any kind (the computer screen, PDF and HTML artifact viewers) are off:
 * the page's CSP has `frame-src 'none'`, so they could not load anyway, and a placeholder says
 * so instead of an empty, broken frame.
 */
export const EMBEDDED_FRAMES_ENABLED = false;

export function installBrowserControls(): void {
  installStorageGuard();
  reloadRestoredPages();
  void purgeBrowserState({ preferences: true });
}

/** Test seam. */
export function resetBrowserControlsForTest(): void {
  ending = false;
  memory.local.clear();
  memory.session.clear();
}
