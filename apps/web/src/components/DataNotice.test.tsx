// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Fresh module per test: the capability lookup is cached for the page's lifetime. */
async function renderFrame(fetchImpl: () => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(fetchImpl));
  vi.resetModules();
  const { DataNoticeFrame } = await import("./DataNotice");
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <DataNoticeFrame>
        <div id="app">app</div>
      </DataNoticeFrame>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { container, root };
}

const capabilities = (extra: Record<string, unknown>) => async () =>
  Response.json({ passwordAuth: true, sso: null, passwordReset: false, resetUrl: null, ...extra });

afterEach(() => {
  vi.unstubAllGlobals();
});

it("shows the rule, the 30-day retention and the endpoint-copy exclusion when enabled", async () => {
  const { container, root } = await renderFrame(capabilities({ dataNotice: true }));
  const notice = container.querySelector("[data-kgrc-data-notice]");
  expect(notice?.getAttribute("role")).toBe("note");
  const text = notice?.textContent ?? "";
  expect(text).toContain("Do not paste client data");
  expect(text).toContain("Refer to tenants by slug.");
  expect(text).toContain("within 30 days");
  expect(text).toContain("Downloads, clipboard copies, screenshots");
  expect(text).toContain("outside that 30-day guarantee");
  // No dismiss control: the banner is persistent.
  expect(notice?.querySelector("button")).toBeNull();
  expect(container.querySelector("#app")?.textContent).toBe("app");
  act(() => root.unmount());
});

it("never presents a network control as a browser egress control", async () => {
  const { DATA_NOTICE_RULE, DATA_NOTICE_RETENTION } = await import("./DataNotice");
  expect(`${DATA_NOTICE_RULE} ${DATA_NOTICE_RETENTION}`).not.toMatch(
    /egress|outbound|network|firewall|SSM|Session Manager|Cloudflare/i,
  );
});

it.each([
  ["the capability is absent", capabilities({})],
  ["the capability is false", capabilities({ dataNotice: false })],
  ["the lookup fails", async () => new Response("down", { status: 503 })],
])("leaves the tree untouched when %s", async (_label, fetchImpl) => {
  const { container, root } = await renderFrame(fetchImpl);
  expect(container.querySelector("[data-kgrc-data-notice]")).toBeNull();
  expect(container.innerHTML).toBe('<div id="app">app</div>');
  act(() => root.unmount());
});
