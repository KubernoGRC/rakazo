import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

// Fork: remote markdown images are inert text, whatever the reader's setting or a tap.
// See docs/fork-browser-controls.md; browser-controls.spec.ts checks the network side.
const imageHost = "https://images.example.test/";
const remoteImage = `${imageHost}chart.png?d=conversation-data`;

async function watchImageHost(page: Page) {
  const requests: string[] = [];
  await page.route(`${imageHost}**`, async (route) => {
    requests.push(route.request().url());
    await route.abort();
  });
  return requests;
}

async function sendImageReply(page: Page, name: string) {
  await signup(page, `${name}-${Date.now()}@rakazo.test`, "password12", "Markdown Image");
  await completeOnboarding(page);
  const composer = page.getByRole("combobox", { name: /^Message/ });
  await expect(composer).toBeVisible();
  await composer.fill(`Here is the chart: ![Quarterly chart](${remoteImage})`);
  await composer.press("Enter");
  // The scripted runtime echoes the prompt back, so the markdown image lands in a bot bubble.
  return page.getByTestId("message-bot-bubble").last();
}

test("a remote markdown image in a bot reply is inert text", async ({ page }, testInfo) => {
  const requests = await watchImageHost(page);
  const bubble = await sendImageReply(page, "markdown-image");

  const placeholder = bubble.locator('[data-remote-image="inert"]');
  await expect(placeholder).toBeVisible({ timeout: 20_000 });
  await expect(placeholder).toContainText("Quarterly chart");
  await expect(placeholder).toContainText("images.example.test");
  await expect(bubble.getByRole("button", { name: /Quarterly chart/ })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "markdown-remote-image-inert");

  await placeholder.click();
  await expect(bubble.locator("img")).toHaveCount(0);
  expect(requests).toEqual([]);
});

test("a remote markdown image stays inert when a legacy setting asked to load it", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("rakazo.loadRemoteImages", "on"));
  const requests = await watchImageHost(page);
  const bubble = await sendImageReply(page, "markdown-image-auto");

  await expect(bubble.locator('[data-remote-image="inert"]')).toBeVisible({ timeout: 20_000 });
  await expect(bubble.locator("img")).toHaveCount(0);
  expect(requests).toEqual([]);
});
