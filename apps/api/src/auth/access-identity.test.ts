import type { AccessVerdict, AccessVerifier } from "@rakazo/auth";
import { SCREEN_TARGET_ENDPOINT } from "@rakazo/core/node/screen-capability";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  ACCESS_REQUIRED_BODY,
  accessIdentityGate,
  createAccessSessionBinding,
} from "./access-identity.js";

/** Accepts exactly the assertion `valid:<subject>`; the real checks are tested in @rakazo/auth. */
const verifier: AccessVerifier = {
  ready: async () => true,
  verify: async (headers): Promise<AccessVerdict> => {
    const value = headers.get("cf-access-jwt-assertion");
    if (!value) return { ok: false, reason: "missing" };
    return value.startsWith("valid:")
      ? {
          ok: true,
          email: "person@example.test",
          subject: value.slice("valid:".length),
          issuedAt: undefined,
        }
      : { ok: false, reason: "bad_signature" };
  },
};

function gated(exemptWebhooks?: string[]) {
  const app = new Hono();
  app.use("*", accessIdentityGate(verifier, exemptWebhooks ? { exemptWebhooks } : {}));
  app.all("*", (c) => c.text("reached"));
  return app;
}

describe("access identity gate", () => {
  it("lets a verified request through", async () => {
    const response = await gated().request("/rpc/threads/list", {
      headers: { "cf-access-jwt-assertion": "valid:subject-1" },
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

  it("lets an exempt provider's webhook POST through without an assertion", async () => {
    const response = await gated(["teams"]).request("/api/v1/messaging/webhook/teams", {
      method: "POST",
    });
    expect(await response.text()).toBe("reached");
  });

  it.each([
    ["not exempted", undefined, "POST", "/api/v1/messaging/webhook/teams"],
    ["another provider", ["teams"], "POST", "/api/v1/messaging/webhook/slack"],
    ["a GET", ["teams"], "GET", "/api/v1/messaging/webhook/teams"],
    ["a path below it", ["teams"], "POST", "/api/v1/messaging/webhook/teams/x"],
    ["a trailing slash", ["teams"], "POST", "/api/v1/messaging/webhook/teams/"],
    ["the legacy phone webhook", ["teams"], "POST", "/api/v1/phone/webhook"],
  ])("still requires an assertion for a webhook %s", async (_label, exempt, method, path) => {
    const response = await gated(exempt).request(path, { method });
    expect(response.status).toBe(401);
  });
});

describe("access session binding", () => {
  const session = { session: { id: "session-1", userId: "user-1" } };
  const request = (assertion?: string) =>
    new Request("http://api.example.test/rpc/x", {
      headers: assertion ? { "cf-access-jwt-assertion": assertion } : {},
    });
  const binding = (subject: string | undefined) => {
    const endSession = vi.fn(async () => undefined);
    const bound = createAccessSessionBinding(verifier, {
      linkedSubject: async () => subject,
      endSession,
    });
    return { bound, endSession };
  };

  it("accepts a session whose user is linked to the verified subject", async () => {
    const { bound, endSession } = binding("subject-1");
    expect(await bound(request("valid:subject-1"), session)).toBe(true);
    expect(endSession).not.toHaveBeenCalled();
  });

  it("ends a session whose user is linked to another subject", async () => {
    const { bound, endSession } = binding("subject-1");
    expect(await bound(request("valid:subject-2"), session)).toBe(false);
    expect(endSession).toHaveBeenCalledWith({ id: "session-1", userId: "user-1" });
  });

  it("ends a session whose user has no access link", async () => {
    const { bound, endSession } = binding(undefined);
    expect(await bound(request("valid:subject-1"), session)).toBe(false);
    expect(endSession).toHaveBeenCalled();
  });

  it("refuses a session cookie with no valid assertion", async () => {
    const { bound } = binding("subject-1");
    expect(await bound(request(), session)).toBe(false);
    expect(await bound(request("forged"), session)).toBe(false);
  });
});
