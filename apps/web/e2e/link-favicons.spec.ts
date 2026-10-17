import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

// Fork: no link icons. Resolving one is a server-side fetch of a site a message chose, so links
// draw the neutral globe and nobody asks the API, or the site. See docs/fork-browser-controls.md.

// The scripted runtime echoes the first 180 characters of the prompt back as its reply.
const reply =
  "[Post](https://x.example.test/a/status/1) and [odds](https://x.example.test/a/status/2). Guide: https://www.docs.example.test/guide/start/ or [plain](https://plain.example.test/)";

test("links in a bot reply draw a globe and look nothing up", async ({ page }, testInfo) => {
  const asked: string[] = [];
  await page.route("**/rpc/links/favicon", async (route) => {
    asked.push(route.request().url());
    await route.fulfill({ json: { json: { icon: null } } });
  });
  const direct: string[] = [];
  await page.route(/^https?:\/\/[^/]*example\.test\//, async (route) => {
    direct.push(route.request().url());
    await route.abort();
  });

  await signup(page, `link-favicons-${Date.now()}@rakazo.test`, "password12", "Link Icons");
  await completeOnboarding(page);
  const composer = page.getByRole("combobox", { name: /^Message/ });
  await expect(composer).toBeVisible();
  await composer.fill(reply);
  await composer.press("Enter");
  const bubble = page.getByTestId("message-bot-bubble").last();

  const post = bubble.getByRole("link", { name: "Post", exact: true });
  await expect(post).toBeVisible({ timeout: 20_000 });
  await expect(post).toHaveAttribute("href", "https://x.example.test/a/status/1");
  await expect(post).toHaveAttribute("rel", /noreferrer/);
  await expect(post.locator("svg")).toBeVisible();

  // A bare URL still reads as host and path.
  const guide = bubble.getByRole("link", { name: "docs.example.test/guide/start" });
  await expect(guide).toHaveAttribute("href", "https://www.docs.example.test/guide/start/");

  await page.waitForTimeout(2_000);
  await expect(bubble.locator("img")).toHaveCount(0);
  expect(asked).toEqual([]);
  expect(direct).toEqual([]);

  await bubble.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "link-favicons-bot-reply");
});
