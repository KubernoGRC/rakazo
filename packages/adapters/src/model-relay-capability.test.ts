import { describe, expect, it } from "vitest";
import {
  encodeRelayCapability,
  issueRelayCapability,
  signRelayCapabilityPayload,
} from "./model-relay-capability.js";

describe("model relay capability issuer", () => {
  // infra/sandboxes/supervisor/src/model-relay.test.ts asserts this same vector.
  it("matches the shared fixed vector", () => {
    const encoded = Buffer.from(
      JSON.stringify({ id: "0123456789abcdef", run: "r", user: "u", model: "m", exp: 1, max: 1 }),
    ).toString("base64url");
    expect(signRelayCapabilityPayload(encoded, "k".repeat(32))).toBe(
      "rF8cRQPnLcokYc1CdP1jI8CUWgRB4nOUbvVBvX6tGUU",
    );
  });

  it("issues a random id bound to the run, user, model, expiry and allowance", () => {
    const first = issueRelayCapability({
      key: "k".repeat(32),
      run: "run-1",
      user: "user-1",
      model: "m",
      ttlMs: 60_000,
      max: 10,
      now: 1_000,
    });
    const second = issueRelayCapability({
      key: "k".repeat(32),
      run: "run-1",
      user: "user-1",
      model: "m",
      ttlMs: 60_000,
      max: 10,
      now: 1_000,
    });
    expect(first.claims).toMatchObject({ run: "run-1", user: "user-1", model: "m", exp: 61_000 });
    expect(first.claims.id).toHaveLength(32);
    expect(first.claims.id).not.toBe(second.claims.id);
    expect(first.token).toBe(encodeRelayCapability(first.claims, "k".repeat(32)));
    expect(() =>
      issueRelayCapability({ key: "short", run: "r", user: "u", model: "m", ttlMs: 1, max: 1 }),
    ).toThrow(/32/);
  });
});
