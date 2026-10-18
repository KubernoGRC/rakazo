// Fork: the browser canaries for docs/fork-browser-controls.md.
//
// Egress: a reply naming an attacker URL as a Markdown image, raw HTML image, media element and
// a previewable link must cause zero requests at a canary server the browser can really reach.
// Storage: a canary in chat and in a draft must reach no persistent browser store, through
// reload, logout, expiry, back navigation, offline navigation and an upgrade from a profile an
// older build wrote to.
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Page, Response } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { completeOnboarding, signup } from "./helpers";

type Canary = { url: string; hits: string[]; close: () => Promise<void> };

/** A real listener, not page.route: a request that left the browser by any path is counted. */
async function startCanaryServer(): Promise<Canary> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "image/png" });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function sendReply(page: Page, text: string) {
  const composer = page.getByRole("combobox", { name: /^Message/ });
  await expect(composer).toBeVisible();
  const bubbles = page.getByTestId("message-bot-bubble");
  const before = await bubbles.count();
  await composer.fill(text);
  await composer.press("Enter");
  // The scripted runtime echoes the prompt, so the text lands in a new bot bubble. Wait for it
  // before the next message, so a reply still running cannot swallow the next prompt.
  await expect(bubbles).toHaveCount(before + 1, { timeout: 30_000 });
  return bubbles.last();
}

test("an attacker-URL reply makes zero requests at the canary server", async ({
  page,
  baseURL,
}) => {
  const canary = await startCanaryServer();
  const appOrigin = new URL(baseURL ?? "http://127.0.0.1:5173").origin;
  const foreign: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.protocol === "data:" || url.protocol === "blob:") return;
    if (url.origin !== appOrigin) foreign.push(request.url());
  });
  const faviconLookups: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/rpc/links/favicon")) faviconLookups.push(request.url());
  });
  try {
    await signup(page, `egress-canary-${Date.now()}@rakazo.test`, "password12", "Egress Canary");
    await completeOnboarding(page);

    const token = `egress-${Date.now()}`;
    const replies = [
      `Chart: ![${token}](${canary.url}/${token}/markdown.png)`,
      `Raw <img src="${canary.url}/${token}/raw.png" alt="${token}"> html`,
      `Media <video src="${canary.url}/${token}/v.mp4" autoplay></video><audio src="${canary.url}/${token}/a.mp3" autoplay></audio>`,
      `Linked [![b](${canary.url}/${token}/badge.svg)](${canary.url}/${token}/page) and ${canary.url}/${token}/bare`,
    ];
    for (const reply of replies) {
      const bubble = await sendReply(page, reply);
      await bubble.scrollIntoViewIfNeeded();
    }
    const thread = page.getByTestId("message-bot-bubble");
    await expect(thread).toHaveCount(replies.length, { timeout: 20_000 });

    // Nothing that could fetch: no image, media or frame element points at the canary.
    for (const selector of ["img", "video", "audio", "iframe", "source", "object", "embed"]) {
      await expect(page.locator(`${selector}[src*="${token}"]`)).toHaveCount(0);
    }
    // The remote image is inert text, and the link is an ordinary anchor with no referrer.
    await expect(page.locator('[data-remote-image="inert"]').first()).toBeVisible();
    const links = page.locator(`a[href^="${canary.url}/"]`);
    await expect(links.first()).toBeVisible();
    for (const link of await links.all()) {
      await expect(link).toHaveAttribute("rel", /noreferrer/);
    }

    // Lazy content, hover previews and late renders get their chance.
    for (const link of await links.all()) await link.hover();
    await page.mouse.wheel(0, 2_000);
    await page.waitForTimeout(3_000);

    expect(canary.hits).toEqual([]);
    expect(foreign).toEqual([]);
    expect(faviconLookups).toEqual([]);
  } finally {
    await canary.close();
  }
});

async function storageDump(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const parts: string[] = [];
    // key()/length see only what the store holds; the guard's page-memory copies are not listed.
    for (const storage of [localStorage, sessionStorage]) {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key !== null) parts.push(`${key}=${storage.getItem(key)}`);
      }
    }
    if (typeof indexedDB.databases === "function") {
      for (const db of await indexedDB.databases()) parts.push(`idb:${db.name}`);
    }
    if (typeof caches !== "undefined") {
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        for (const request of await cache.keys()) {
          const response = await cache.match(request);
          parts.push(`cache:${name}:${request.url}:${response ? await response.text() : ""}`);
        }
      }
    }
    return parts.join("\n");
  });
}

function watchNoStore(page: Page) {
  const cacheable: string[] = [];
  page.on("response", (response: Response) => {
    const path = new URL(response.url()).pathname;
    if (!path.startsWith("/api/") && !path.startsWith("/rpc/")) return;
    if (response.headers()["cache-control"] !== "no-store") {
      cacheable.push(`${response.status()} ${path} ${response.headers()["cache-control"]}`);
    }
  });
  return cacheable;
}

test("a chat canary reaches no browser store through reload, logout, back and offline", async ({
  page,
  context,
}) => {
  const cacheable = watchNoStore(page);
  await signup(page, `storage-canary-${Date.now()}@rakazo.test`, "password12", "Storage Canary");
  await completeOnboarding(page);

  const token = `stored-${Date.now()}`;
  await sendReply(page, `Remember ${token}`);
  await expect(page.getByText(`Remember ${token}`).first()).toBeVisible();
  // An unsent draft is chat content too.
  const composer = page.getByRole("combobox", { name: /^Message/ });
  await composer.fill(`draft ${token}`);
  await page.waitForTimeout(1_000);
  expect(await storageDump(page)).not.toContain(token);

  await page.reload();
  await expect(page.getByText(`Remember ${token}`).first()).toBeVisible({ timeout: 20_000 });
  expect(await storageDump(page)).not.toContain(token);
  await expect(page.getByRole("combobox", { name: /^Message/ })).not.toHaveValue(/stored-/);

  const chatUrl = page.url();
  await page.getByTestId("user-menu-trigger").click();
  await page
    .locator('[data-slot="popover-content"]')
    .getByRole("button", { name: "Log out", exact: true })
    .click();
  await page.waitForURL((url) => !url.pathname.startsWith("/app"), { timeout: 20_000 });
  await page.waitForLoadState("load");
  await expect(page.getByText(token)).toHaveCount(0);
  const afterLogout = await storageDump(page);
  expect(afterLogout).not.toContain(token);
  // Preferences go too: logout leaves nothing of the session's browser state.
  expect(afterLogout).not.toContain("rakazo:space-id");

  await page.goBack().catch(() => undefined);
  await page.waitForLoadState("load");
  await expect(page.getByText(token)).toHaveCount(0);

  await context.setOffline(true);
  await page.goto(chatUrl).catch(() => undefined);
  await expect(page.getByText(token)).toHaveCount(0);
  await page.goBack().catch(() => undefined);
  await expect(page.getByText(token)).toHaveCount(0);
  await context.setOffline(false);

  expect(cacheable).toEqual([]);
});

test("an expired session shows no stale chat and leaves no canary", async ({ page, context }) => {
  await signup(page, `expiry-canary-${Date.now()}@rakazo.test`, "password12", "Expiry Canary");
  await completeOnboarding(page);
  const token = `expired-${Date.now()}`;
  await sendReply(page, `Remember ${token}`);
  await expect(page.getByText(`Remember ${token}`).first()).toBeVisible();
  await page.getByRole("combobox", { name: /^Message/ }).fill(`draft ${token}`);
  await page.waitForTimeout(1_000);

  // The server no longer recognises the browser: its cookie is gone, as at expiry.
  await context.clearCookies();
  await page.reload();
  await page.waitForURL((url) => !url.pathname.startsWith("/app"), { timeout: 20_000 });
  await expect(page.getByText(token)).toHaveCount(0);
  expect(await storageDump(page)).not.toContain(token);
});

async function plantPreCutoverProfile(page: Page, token: string) {
  // A static file of the same origin: the app does not run, so nothing guards the stores.
  await page.goto("/favicon.png");
  await page.evaluate(async (value) => {
    localStorage.setItem("rakazo.composerDraft.legacy", value);
    localStorage.setItem("rakazo.loadRemoteImages", "on");
    localStorage.setItem("rakazo.uiAppearance", "dark");
    sessionStorage.setItem("legacy-chat", value);
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open("legacy-chat", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("messages");
      open.onsuccess = () => {
        const tx = open.result.transaction("messages", "readwrite");
        tx.objectStore("messages").put(value, "m1");
        tx.oncomplete = () => {
          open.result.close();
          resolve();
        };
      };
      open.onerror = () => reject(open.error);
    });
    const cache = await caches.open("legacy-offline");
    await cache.put("/legacy-chat.json", new Response(value));
  }, token);
}

test("a pre-cutover browser profile is swept at first load", async ({ page }) => {
  const token = `legacy-${Date.now()}`;
  await plantPreCutoverProfile(page, token);
  expect(await storageDump(page)).toContain(token);
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect.poll(() => storageDump(page), { timeout: 10_000 }).not.toContain(token);
  const dump = await storageDump(page);
  expect(dump).not.toContain("idb:legacy-chat");
  expect(dump).not.toContain("legacy-offline");
  expect(dump).not.toContain("rakazo.loadRemoteImages");
  // A preference survives the cutover sweep.
  expect(dump).toContain("rakazo.uiAppearance=dark");
});
