// @vitest-environment node
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PdfViewer } from "./PdfViewer";
import { SandboxedHtmlViewer } from "./SandboxedHtmlViewer";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));

// Fork: the page's CSP has frame-src 'none'; no viewer may render a frame.
describe("embedded viewers", () => {
  it.each([
    ["HTML", <SandboxedHtmlViewer key="h" title="Notes" html="<img src=https://canary.test/x>" />],
    ["PDF", <PdfViewer key="p" title="Report" bytes={new Uint8Array([37, 80, 68, 70])} />],
  ])("the %s viewer is a placeholder, not a frame", (_name, element) => {
    const html = renderToStaticMarkup(element);
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("canary.test");
    expect(html).toContain('data-embedded-content="disabled"');
  });
});
