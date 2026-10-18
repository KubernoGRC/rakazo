// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  endBrowserSession,
  installStorageGuard,
  isPreferenceKey,
  purgeBrowserState,
  reloadRestoredPages,
  resetBrowserControlsForTest,
  watchSessionEnd,
} from "./browser-controls";
import { COMPOSER_DRAFT_STORAGE_PREFIX } from "./composer-draft";

const CANARY = "canary-7f3a";

/** What really reached the store, bypassing the guard's memory copy. */
function persisted(storage: Storage): Record<string, string> {
  const out: Record<string, string> = {};
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key !== null) out[key] = Object.getPrototypeOf(storage).getItem.call(storage, key) ?? "";
  }
  return out;
}

beforeAll(() => installStorageGuard());

beforeEach(() => {
  resetBrowserControlsForTest();
  localStorage.clear();
  sessionStorage.clear();
});

describe("storage guard", () => {
  it("keeps a composer draft in page memory only", () => {
    const key = `${COMPOSER_DRAFT_STORAGE_PREFIX}thread-1`;
    localStorage.setItem(key, CANARY);
    expect(localStorage.getItem(key)).toBe(CANARY);
    expect(JSON.stringify(persisted(localStorage))).not.toContain(CANARY);
  });

  it("persists listed preferences", () => {
    localStorage.setItem("rakazo.uiAppearance", "dark");
    localStorage.setItem("rakazo:right-panel-state:u:s:bot:b", '{"panel":"settings"}');
    expect(persisted(localStorage)).toEqual({
      "rakazo.uiAppearance": "dark",
      "rakazo:right-panel-state:u:s:bot:b": '{"panel":"settings"}',
    });
  });

  it("keeps unlisted sessionStorage writes in memory", () => {
    sessionStorage.setItem("chat", CANARY);
    sessionStorage.setItem("rk:preload-recovery", "1");
    expect(sessionStorage.getItem("chat")).toBe(CANARY);
    expect(persisted(sessionStorage)).toEqual({ "rk:preload-recovery": "1" });
  });

  it("forgets memory copies on removeItem", () => {
    localStorage.setItem("rakazo.composerDraft.x", CANARY);
    localStorage.removeItem("rakazo.composerDraft.x");
    expect(localStorage.getItem("rakazo.composerDraft.x")).toBeNull();
  });

  it.each(["rakazo.composerDraft.t", "rakazo.loadRemoteImages", "anything-else"])(
    "does not list %s as a preference",
    (key) => {
      expect(isPreferenceKey(key)).toBe(false);
    },
  );
});

describe("purge", () => {
  function plantLegacyProfile() {
    // A pre-cutover build wrote these straight to the store.
    const raw = Object.getPrototypeOf(localStorage).setItem as Storage["setItem"];
    raw.call(localStorage, "rakazo.composerDraft.t", CANARY);
    raw.call(localStorage, "rakazo.loadRemoteImages", "on");
    raw.call(localStorage, "rakazo.uiLocale", "fr");
    raw.call(sessionStorage, "draft", CANARY);
  }

  it("clears a pre-cutover profile at load and keeps preferences", async () => {
    plantLegacyProfile();
    await purgeBrowserState({ preferences: true });
    expect(persisted(localStorage)).toEqual({ "rakazo.uiLocale": "fr" });
    expect(persisted(sessionStorage)).toEqual({});
  });

  it("clears preferences too when a session ends", async () => {
    plantLegacyProfile();
    await purgeBrowserState({ preferences: false });
    expect(persisted(localStorage)).toEqual({});
  });

  it("drops memory copies", async () => {
    localStorage.setItem("rakazo.composerDraft.t", CANARY);
    await purgeBrowserState({ preferences: true });
    expect(localStorage.getItem("rakazo.composerDraft.t")).toBeNull();
  });

  it("deletes IndexedDB databases, caches and service workers", async () => {
    const deleteDatabase = vi.fn(() => {
      const request = {} as IDBOpenDBRequest;
      queueMicrotask(() => request.onsuccess?.(new Event("success")));
      return request;
    });
    const deleteCache = vi.fn(async () => true);
    const unregister = vi.fn(async () => true);
    vi.stubGlobal("indexedDB", {
      databases: async () => [{ name: "legacy-chat" }],
      deleteDatabase,
    });
    vi.stubGlobal("caches", { keys: async () => ["v1"], delete: deleteCache });
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { getRegistrations: async () => [{ unregister }] },
    });
    try {
      await purgeBrowserState({ preferences: true });
      expect(deleteDatabase).toHaveBeenCalledWith("legacy-chat");
      expect(deleteCache).toHaveBeenCalledWith("v1");
      expect(unregister).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      Reflect.deleteProperty(navigator, "serviceWorker");
    }
  });

  it("waits for an IndexedDB delete to finish before resolving", async () => {
    let finish: () => void = () => {};
    vi.stubGlobal("indexedDB", {
      databases: async () => [{ name: "legacy-chat" }],
      deleteDatabase: () => {
        const request = {} as IDBOpenDBRequest;
        finish = () => request.onsuccess?.(new Event("success"));
        return request;
      },
    });
    try {
      let settled = false;
      const purge = purgeBrowserState({ preferences: false, indexedDbWaitMs: 60_000 }).then(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(settled).toBe(false);
      finish();
      await purge;
      expect(settled).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("stops waiting on a delete another tab blocks", async () => {
    vi.stubGlobal("indexedDB", {
      databases: async () => [{ name: "legacy-chat" }],
      deleteDatabase: () => ({}) as IDBOpenDBRequest,
    });
    try {
      await purgeBrowserState({ preferences: false, indexedDbWaitMs: 10 });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("session end", () => {
  it("replaces the page after clearing storage, once", async () => {
    localStorage.setItem("rakazo.uiAppearance", "dark");
    const replace = vi.fn();
    const target = { replace, href: "http://app.test/sign-in" };
    await endBrowserSession(target);
    await endBrowserSession(target);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith("http://app.test/sign-in");
    expect(persisted(localStorage)).toEqual({});
  });

  it("fires on signed in → signed out only", () => {
    const end = vi.fn(async () => undefined);
    const cold = watchSessionEnd(end);
    cold("loading");
    cold("anonymous");
    expect(end).not.toHaveBeenCalled();
    const live = watchSessionEnd(end);
    live("authenticated");
    live("unreachable");
    expect(end).not.toHaveBeenCalled();
    live("anonymous");
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("reloads a page restored from the back/forward cache", () => {
    const target = new EventTarget() as unknown as Window;
    const reload = vi.fn();
    Object.defineProperty(target, "location", { value: { reload } });
    reloadRestoredPages(target);
    const fresh = Object.assign(new Event("pageshow"), { persisted: false });
    target.dispatchEvent(fresh);
    expect(reload).not.toHaveBeenCalled();
    target.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
