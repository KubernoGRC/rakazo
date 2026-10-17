// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  builtScriptHashes,
  contentSecurityPolicy,
  forceBrowserControlHeaders,
  inlineScriptHashes,
} from "./browser-controls-server";

function directives(policy: string) {
  return new Map(
    policy.split(";").map((part) => {
      const [name = "", ...values] = part.trim().split(/\s+/);
      return [name, values] as const;
    }),
  );
}

describe("content security policy", () => {
  const policy = directives(contentSecurityPolicy(["'sha256-abc'"]));

  it.each([
    ["img-src", ["'self'", "data:", "blob:"]],
    ["media-src", ["'self'", "blob:"]],
    ["object-src", ["'none'"]],
    ["frame-src", ["'none'"]],
    ["base-uri", ["'none'"]],
    ["script-src", ["'self'", "'sha256-abc'"]],
    ["font-src", ["'self'"]],
    ["connect-src", ["'self'"]],
  ])("%s is %j", (name, values) => {
    expect(policy.get(name)).toEqual(values);
  });

  it("names no other host and no scheme wildcard", () => {
    for (const [name, values] of policy) {
      for (const value of values) {
        expect(value, `${name} ${value}`).toMatch(/^('[^']+'|data:|blob:)$/);
      }
    }
  });
});

describe("inline script hashes", () => {
  it("hashes inline scripts only", () => {
    const body = "\n  console.log(1);\n";
    const html = `<script>${body}</script><script type="module" src="/a.js"></script><script></script>`;
    const expected = createHash("sha256").update(body).digest("base64");
    expect(inlineScriptHashes(html)).toEqual([`'sha256-${expected}'`]);
  });

  it("covers the theme bootstrap in index.html", () => {
    const html = readFileSync(path.resolve(import.meta.dirname, "../index.html"), "utf8");
    expect(inlineScriptHashes(html)).toHaveLength(1);
  });
});

const servers: http.Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function serve(handler: (res: http.ServerResponse) => void, path = "/") {
  const middleware = forceBrowserControlHeaders(() => ["'sha256-abc'"]);
  const server = http.createServer((req, res) => middleware(req, res, () => handler(res)));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return fetch(`http://127.0.0.1:${port}${path}`);
}

describe("forced headers", () => {
  it("survive a later setHeader", async () => {
    const response = await serve((res) => {
      res.setHeader("cache-control", "max-age=31536000, immutable");
      res.setHeader("etag", "W/1");
      res.end("ok");
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("etag")).toBeNull();
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toContain("frame-src 'none'");
  });

  it("survive headers passed to writeHead, as a proxy does", async () => {
    const response = await serve((res) => {
      res.writeHead(500, "Oops", { "Cache-Control": "public, max-age=60", "x-upstream": "1" });
      res.end("canary in an error");
    });
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-upstream")).toBe("1");
    expect(response.headers.get("content-security-policy")).toContain("img-src 'self'");
  });
});

describe("a response's own policy", () => {
  it("is kept beside ours, never replaced", async () => {
    const response = await serve((res) => {
      res.writeHead(200, { "Content-Security-Policy": "sandbox allow-scripts" });
      res.end("screen");
    });
    const policy = response.headers.get("content-security-policy") ?? "";
    expect(policy).toContain("sandbox allow-scripts");
    expect(policy).toContain("frame-src 'none'");
  });

  it("set with setHeader is kept too", async () => {
    const response = await serve((res) => {
      res.setHeader("content-security-policy", "sandbox");
      res.end("screen");
    });
    expect(response.headers.get("content-security-policy")).toMatch(/^sandbox, default-src/);
  });
});

describe("the screen proxy", () => {
  it("keeps only its own sandbox policy, and is still no-store", async () => {
    const response = await serve((res) => {
      res.writeHead(200, { "Content-Security-Policy": "sandbox allow-scripts" });
      res.end("screen");
    }, "/novnc/session/view/x");
    expect(response.headers.get("content-security-policy")).toBe("sandbox allow-scripts");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("built script hashes", () => {
  it("are empty, not an error, without a built page", () => {
    expect(builtScriptHashes("/nonexistent/index.html")).toEqual([]);
  });
});
