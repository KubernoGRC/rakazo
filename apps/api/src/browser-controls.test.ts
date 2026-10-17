import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { browserControlHeaders } from "./browser-controls.js";

function testApp() {
  const app = new Hono();
  app.use("*", browserControlHeaders());
  app.get("/rpc/chat", (c) => c.json({ text: "canary" }));
  app.get("/api/attachments/a", (c) => {
    c.header("cache-control", "private, max-age=86400");
    c.header("etag", '"abc"');
    return c.body("canary bytes");
  });
  app.get("/api/gate", (c) => c.json({ error: "canary echoed" }, 401));
  app.get("/api/throws", () => {
    throw new Error("canary in an error");
  });
  return app;
}

describe("browser control headers", () => {
  it.each(["/rpc/chat", "/api/attachments/a", "/api/gate", "/api/throws", "/api/missing"])(
    "%s is no-store with no referrer",
    async (path) => {
      const response = await testApp().request(path);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("etag")).toBeNull();
    },
  );

  it("overrides a handler's own caching header", async () => {
    const response = await testApp().request("/api/attachments/a");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("canary bytes");
  });

  it("asks the browser to clear the origin's cache and storage on sign-out only", async () => {
    const app = new Hono();
    app.use("*", browserControlHeaders());
    app.post("/api/auth/sign-out", (c) => c.json({ success: true }));
    app.post("/api/auth/sign-in/email", (c) => c.json({ ok: true }));
    const out = await app.request("/api/auth/sign-out", { method: "POST" });
    expect(out.headers.get("clear-site-data")).toBe('"cache", "storage"');
    const other = await app.request("/api/auth/sign-in/email", { method: "POST" });
    expect(other.headers.get("clear-site-data")).toBeNull();
  });

  it("covers a response whose headers are immutable", async () => {
    const app = new Hono();
    app.use("*", browserControlHeaders());
    // A fetch() response has an immutable Headers guard, as a proxied upstream reply does.
    app.get("/immutable", () => fetch("data:text/plain,canary"));
    const response = await app.request("/immutable");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("canary");
  });
});
