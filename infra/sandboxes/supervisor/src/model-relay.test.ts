import { describe, expect, it, vi } from "vitest";
import type { RelayEvent } from "./model-relay.js";
import { createModelRelayApp } from "./model-relay.js";
import type { ModelRelayConfig, RelayCapability } from "./model-relay-logic.js";
import {
  CAPABILITY_PREFIX,
  capabilityFromHeaders,
  modelRelayConfigFromEnv,
  parseRelayPath,
  signCapabilityPayload,
  verifyCapability,
} from "./model-relay-logic.js";

const KEY = "k".repeat(32);
const MODEL = "us.anthropic.example-model-v1:0";
const NOW = 1_800_000_000_000;

function capability(overrides: Partial<RelayCapability> = {}, key = KEY) {
  const payload: RelayCapability = {
    id: "cap-0123456789abcdef",
    run: "run-1",
    user: "user-1",
    model: MODEL,
    exp: NOW + 60_000,
    max: 2,
    ...overrides,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${CAPABILITY_PREFIX}.${encoded}.${signCapabilityPayload(encoded, key)}`;
}

function config(overrides: Partial<ModelRelayConfig> = {}): ModelRelayConfig {
  return {
    signingKey: KEY,
    upstream: "https://bedrock-runtime.example.test",
    models: [MODEL],
    upstreamToken: "upstream-secret",
    maxBodyBytes: 1024,
    host: "127.0.0.1",
    port: 8790,
    ...overrides,
  };
}

function relay(overrides: Partial<ModelRelayConfig> = {}) {
  const events: RelayEvent[] = [];
  const upstream = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response('{"ok":true}', {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-amzn-requestid": "req-1",
          "set-cookie": "never=forwarded",
        },
      }),
  );
  const app = createModelRelayApp({
    config: config(overrides),
    fetch: upstream as unknown as typeof fetch,
    now: () => NOW,
    log: (event) => events.push(event),
  });
  const invoke = (token: string | undefined, path = `/model/${encodeURIComponent(MODEL)}/invoke`) =>
    app.request(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "x-amz-security-token": "client-supplied",
      },
      body: '{"messages":[]}',
    });
  return { app, events, upstream, invoke };
}

describe("model relay capability", () => {
  // The issuer (packages/adapters/src/model-relay-capability.ts) asserts this same vector.
  it("matches the shared fixed vector", () => {
    const encoded = Buffer.from(
      JSON.stringify({ id: "0123456789abcdef", run: "r", user: "u", model: "m", exp: 1, max: 1 }),
    ).toString("base64url");
    expect(signCapabilityPayload(encoded, "k".repeat(32))).toBe(
      "rF8cRQPnLcokYc1CdP1jI8CUWgRB4nOUbvVBvX6tGUU",
    );
  });

  it("accepts a valid capability and refuses tampering, other keys and expiry", () => {
    expect(verifyCapability(capability(), KEY, NOW)).toMatchObject({ ok: true });
    expect(verifyCapability(capability({}, "x".repeat(32)), KEY, NOW)).toEqual({
      ok: false,
      reason: "signature",
    });
    const [prefix, , sig] = capability().split(".");
    const forged = Buffer.from(JSON.stringify({ model: "other" })).toString("base64url");
    expect(verifyCapability(`${prefix}.${forged}.${sig}`, KEY, NOW)).toEqual({
      ok: false,
      reason: "signature",
    });
    expect(verifyCapability(capability({ exp: NOW }), KEY, NOW)).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(
      verifyCapability(capability({ exp: NOW }), KEY, NOW, { allowExpired: true }),
    ).toMatchObject({ ok: true });
    for (const bad of ["", "rkc1", "rkc1..", "rkc2.a.b", "a.b.c.d"]) {
      expect(verifyCapability(bad, KEY, NOW)).toEqual({ ok: false, reason: "malformed" });
    }
    expect(verifyCapability(capability({ max: 0 }), KEY, NOW)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("reads the capability from either header", () => {
    expect(capabilityFromHeaders(new Headers({ authorization: "Bearer abc" }))).toBe("abc");
    expect(capabilityFromHeaders(new Headers({ "x-rakazo-capability": "def" }))).toBe("def");
    expect(capabilityFromHeaders(new Headers({ authorization: "Basic abc" }))).toBeUndefined();
  });

  it("forwards only InvokeModel paths", () => {
    expect(parseRelayPath(`/model/${encodeURIComponent(MODEL)}/invoke`)).toEqual({
      model: MODEL,
      stream: false,
    });
    expect(parseRelayPath("/model/m/invoke-with-response-stream")).toEqual({
      model: "m",
      stream: true,
    });
    const arn = "arn:aws:bedrock:region:account:inference-profile/x";
    expect(parseRelayPath(`/model/${encodeURIComponent(arn)}/invoke`)?.model).toBe(arn);
    for (const path of [
      "/model/m/converse",
      "/model//invoke",
      "/model/a/b/invoke",
      "/model/a%2Fb/invoke",
      "/model/%ZZ/invoke",
      "/model/a%20b/invoke",
      "/guardrail/x",
    ]) {
      expect(parseRelayPath(path), path).toBeUndefined();
    }
  });
});

describe("model relay", () => {
  it("forwards a permitted call with the relay's credential, not the caller's", async () => {
    const { invoke, upstream, events } = relay();
    const response = await invoke(capability());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"ok":true}');
    expect(response.headers.get("x-amzn-requestid")).toBe("req-1");
    expect(response.headers.get("set-cookie")).toBeNull();

    const [url, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://bedrock-runtime.example.test/model/${encodeURIComponent(MODEL)}/invoke`,
    );
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer upstream-secret");
    expect(headers.get("x-amz-security-token")).toBeNull();
    expect(init.redirect).toBe("error");
    expect(events.at(-1)).toMatchObject({
      event: "model.relayed",
      run: "run-1",
      user: "user-1",
      status: 200,
      requestBytes: 15,
      responseBytes: 11,
    });
    expect(JSON.stringify(events)).not.toContain("upstream-secret");
    expect(JSON.stringify(events)).not.toContain(capability());
  });

  it("refuses missing, forged and expired capabilities before calling upstream", async () => {
    const { invoke, upstream } = relay();
    expect((await invoke(undefined)).status).toBe(401);
    expect((await invoke(capability({}, "x".repeat(32)))).status).toBe(401);
    expect((await invoke(capability({ exp: NOW - 1 }))).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("refuses a model other than the capability's or outside the deployment list", async () => {
    const { invoke, upstream } = relay();
    expect((await invoke(capability(), "/model/other-model/invoke")).status).toBe(403);
    const outside = relay({ models: ["something-else"] });
    expect((await outside.invoke(capability())).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
    expect(outside.upstream).not.toHaveBeenCalled();
  });

  it("enforces the request allowance and revocation", async () => {
    const { app, invoke, upstream } = relay();
    const token = capability({ max: 2 });
    expect((await invoke(token)).status).toBe(200);
    expect((await invoke(token)).status).toBe(200);
    expect((await invoke(token)).status).toBe(429);

    const other = capability({ id: "cap-fedcba9876543210" });
    const revoked = await app.request("/capabilities/revoke", {
      method: "POST",
      headers: { authorization: `Bearer ${other}` },
    });
    expect(revoked.status).toBe(204);
    expect((await invoke(other)).status).toBe(403);
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("refuses other paths and oversized bodies", async () => {
    const { app, upstream } = relay({ maxBodyBytes: 8 });
    expect(
      (
        await app.request("/model/x/converse", {
          method: "POST",
          headers: { authorization: `Bearer ${capability()}` },
        })
      ).status,
    ).toBe(404);
    expect((await app.request("/anything")).status).toBe(404);
    const big = await app.request(`/model/${encodeURIComponent(MODEL)}/invoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${capability()}`, "content-type": "application/json" },
      body: "x".repeat(64),
    });
    expect(big.status).toBe(413);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("re-reads a token file per request and fails closed without one", async () => {
    let token = "first";
    const upstream = vi.fn(async () => new Response("{}"));
    const app = createModelRelayApp({
      config: config({ upstreamToken: undefined, upstreamTokenFile: "/run/token" }),
      fetch: upstream as unknown as typeof fetch,
      now: () => NOW,
      log: () => undefined,
      readToken: async () => token,
    });
    const call = () =>
      app.request(`/model/${encodeURIComponent(MODEL)}/invoke`, {
        method: "POST",
        headers: { authorization: `Bearer ${capability({ max: 5 })}` },
        body: "{}",
      });
    await call();
    token = "second\n";
    await call();
    const auth = upstream.mock.calls.map((args) =>
      new Headers((args as unknown as [string, RequestInit])[1].headers).get("authorization"),
    );
    expect(auth).toEqual(["Bearer first", "Bearer second"]);
    token = "";
    expect((await call()).status).toBe(503);
  });

  it("logs one event when the upstream stream fails or the computer stops reading", async () => {
    const events: RelayEvent[] = [];
    let mode: "error" | "cancel" = "error";
    const upstream = vi.fn(async () => {
      let sent = false;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!sent) {
              sent = true;
              controller.enqueue(new Uint8Array([1, 2, 3]));
              return;
            }
            if (mode === "error") controller.error(new Error("reset"));
          },
        }),
        { status: 200 },
      );
    });
    const app = createModelRelayApp({
      config: config(),
      fetch: upstream as unknown as typeof fetch,
      now: () => NOW,
      log: (event) => events.push(event),
    });
    const call = () =>
      app.request(`/model/${encodeURIComponent(MODEL)}/invoke`, {
        method: "POST",
        headers: { authorization: `Bearer ${capability({ max: 5 })}` },
        body: "{}",
      });

    const failed = await call();
    await expect(failed.text()).rejects.toThrow();
    expect(events.filter((event) => event.event === "model.relayed")).toEqual([
      expect.objectContaining({ reason: "upstream stream failed", responseBytes: 3 }),
    ]);

    mode = "cancel";
    const cancelled = await call();
    const reader = cancelled.body!.getReader();
    await reader.read();
    await reader.cancel();
    const relayed = events.filter((event) => event.event === "model.relayed");
    expect(relayed).toHaveLength(2);
    expect(relayed[1]).toMatchObject({ reason: "response cancelled" });
  });

  it("rechecks expiry after a slow body, so a pruned allowance can't be reused", async () => {
    let clock = NOW;
    const upstream = vi.fn(async () => new Response("{}"));
    const app = createModelRelayApp({
      config: config(),
      fetch: upstream as unknown as typeof fetch,
      now: () => clock,
      log: () => undefined,
    });
    const token = capability({ exp: NOW + 1_000 });
    let release: (() => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        release = () => {
          controller.enqueue(new TextEncoder().encode("{}"));
          controller.close();
        };
      },
    });
    const pending = app.request(`/model/${encodeURIComponent(MODEL)}/invoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body,
      duplex: "half",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    clock = NOW + 2_000;
    release?.();
    expect((await pending).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("reports an unreachable upstream as 502", async () => {
    const app = createModelRelayApp({
      config: config(),
      fetch: (async () => {
        throw new Error("down");
      }) as unknown as typeof fetch,
      now: () => NOW,
      log: () => undefined,
    });
    const response = await app.request(`/model/${encodeURIComponent(MODEL)}/invoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${capability()}` },
      body: "{}",
    });
    expect(response.status).toBe(502);
  });
});

describe("model relay configuration", () => {
  const base = {
    MODEL_RELAY_SIGNING_KEY: KEY,
    AWS_REGION: "us-east-1",
    MODEL_RELAY_MODELS: `${MODEL}, ${MODEL}`,
    AWS_BEARER_TOKEN_BEDROCK: "t",
  };

  it("derives the Bedrock endpoint from the region", () => {
    expect(modelRelayConfigFromEnv(base)).toMatchObject({
      upstream: "https://bedrock-runtime.us-east-1.amazonaws.com",
      models: [MODEL],
      port: 8790,
      host: "0.0.0.0",
    });
  });

  it.each([
    [{ MODEL_RELAY_SIGNING_KEY: "short" }, "MODEL_RELAY_SIGNING_KEY"],
    [{ MODEL_RELAY_MODELS: " " }, "MODEL_RELAY_MODELS"],
    [{ AWS_BEARER_TOKEN_BEDROCK: "" }, "AWS_BEARER_TOKEN_BEDROCK"],
    [{ MODEL_RELAY_UPSTREAM: "http://plain.example" }, "https"],
    [{ MODEL_RELAY_UPSTREAM: "https://u:p@x.example" }, "https"],
    [{ AWS_REGION: "", MODEL_RELAY_UPSTREAM: "" }, "MODEL_RELAY_UPSTREAM"],
    [{ MODEL_RELAY_PORT: "0" }, "MODEL_RELAY_PORT"],
  ])("refuses %j", (overrides, message) => {
    expect(() => modelRelayConfigFromEnv({ ...base, ...overrides })).toThrow(message);
  });
});
