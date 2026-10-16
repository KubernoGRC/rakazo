import type { AccessVerdict, AccessVerifier } from "@rakazo/auth";
import { SCREEN_TARGET_ENDPOINT } from "@rakazo/core/node/screen-capability";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  ACCESS_REQUIRED_BODY,
  accessIdentityGate,
  createAccessSessionBinding,
} from "./access-identity.js";

/** Accepts exactly the assertion `valid:<email>`; the real checks are tested in @rakazo/auth. */
const verifier: AccessVerifier = {
  verify: async (headers): Promise<AccessVerdict> => {
    const value = headers.get("cf-access-jwt-assertion");
    if (!value) return { ok: false, reason: "missing" };
    return value.startsWith("valid:")
      ? { ok: true, email: value.slice("valid:".length) }
      : { ok: false, reason: "bad_signature" };
  },
};

function gated() {
  const app = new Hono();
  app.use("*", accessIdentityGate(verifier));
  app.all("*", (c) => c.text("reached"));
  return app;
}

describe("access identity gate", () => {
  it("lets a verified request through", async () => {
    const response = await gated().request("/rpc/threads/list", {
      headers: { "cf-access-jwt-assertion": "valid:person@example.test" },
    });
    expect(await response.text()).toBe("reached");
  });

  it.each([
    ["no assertion", {}],
    ["an invalid assertion", { "cf-access-jwt-assertion": "forged" }],
    [
      "an email header with no assertion",
      {
        "cf-access-authenticated-user-email": "person@example.test",
        "x-forwarded-email": "person@example.test",
      },
    ],
    ["a session cookie with no assertion", { cookie: "better-auth.session_token=abc" }],
    ["a bearer session with no assertion", { authorization: "Bearer abc" }],
  ])("refuses %s", async (_label, headers) => {
    for (const path of ["/rpc/threads/list", "/api/auth/get-session", "/api/voice/speak"]) {
      const response = await gated().request(path, { headers });
      expect(response.status, path).toBe(401);
      expect(await response.json()).toEqual(ACCESS_REQUIRED_BODY);
    }
  });

  it.each([
    "/health",
    "/ready",
    "/internal/health",
    "/api/auth/capabilities",
    SCREEN_TARGET_ENDPOINT,
  ])("keeps %s reachable without an assertion", async (path) => {
    expect(await (await gated().request(path)).text()).toBe("reached");
  });
});

describe("access session binding", () => {
  const session = (email: string) => ({
    session: { id: "session-1", userId: "user-1" },
    user: { email },
  });
  const request = (assertion?: string) =>
    new Request("http://api.example.test/rpc/x", {
      headers: assertion ? { "cf-access-jwt-assertion": assertion } : {},
    });

  it("accepts a session whose user matches the verified email", async () => {
    const endSession = vi.fn(async () => undefined);
    const bound = createAccessSessionBinding(verifier, endSession);
    expect(await bound(request("valid:person@example.test"), session("Person@Example.test"))).toBe(
      true,
    );
    expect(endSession).not.toHaveBeenCalled();
  });

  it("ends a session whose user differs from the verified email", async () => {
    const endSession = vi.fn(async () => undefined);
    const bound = createAccessSessionBinding(verifier, endSession);
    expect(
      await bound(request("valid:someone-else@example.test"), session("person@example.test")),
    ).toBe(false);
    expect(endSession).toHaveBeenCalledWith({ id: "session-1", userId: "user-1" });
  });

  it("refuses a session cookie with no valid assertion", async () => {
    const endSession = vi.fn(async () => undefined);
    const bound = createAccessSessionBinding(verifier, endSession);
    expect(await bound(request(), session("person@example.test"))).toBe(false);
    expect(await bound(request("forged"), session("person@example.test"))).toBe(false);
  });
});
