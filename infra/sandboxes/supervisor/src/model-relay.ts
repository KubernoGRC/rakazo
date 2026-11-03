import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ModelRelayConfig, RelayCapability } from "./model-relay-logic.js";
import {
  CapabilityLedger,
  capabilityFromHeaders,
  capabilityLabel,
  FORWARDED_REQUEST_HEADERS,
  FORWARDED_RESPONSE_HEADERS,
  parseRelayPath,
  verifyCapability,
} from "./model-relay-logic.js";

/**
 * Fork patch: the model relay. See docs/fork-computer-model-relay.md.
 *
 * It runs as its own container, with no Docker socket and no app secrets: only
 * its signing key and the model credential. The supervisor joins it to every
 * isolated computer network (SANDBOX_ISOLATED_PEERS).
 */

export interface RelayEvent {
  event: "model.relayed" | "model.relay.refused" | "model.relay.revoked";
  capability?: string;
  run?: string;
  user?: string;
  model?: string;
  stream?: boolean;
  status: number;
  reason?: string;
  requestBytes?: number;
  responseBytes?: number;
  durationMs?: number;
}

export interface ModelRelayDeps {
  config: ModelRelayConfig;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (event: RelayEvent) => void;
  readToken?: (path: string) => Promise<string>;
}

const defaultLog = (event: RelayEvent) => {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), ...event })}\n`);
};

export function createModelRelayApp(deps: ModelRelayDeps) {
  const { config } = deps;
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? defaultLog;
  const readToken = deps.readToken ?? ((path: string) => readFile(path, "utf8"));
  const ledger = new CapabilityLedger();
  const app = new Hono();

  const upstreamToken = async () => {
    if (config.upstreamTokenFile) {
      return (await readToken(config.upstreamTokenFile).catch(() => "")).trim();
    }
    return config.upstreamToken ?? "";
  };

  const refuse = (status: number, reason: string, capability?: RelayCapability) => {
    log({
      event: "model.relay.refused",
      status,
      reason,
      ...(capability
        ? {
            capability: capabilityLabel(capability.id),
            run: capability.run,
            user: capability.user,
            model: capability.model,
          }
        : {}),
    });
    return new Response(JSON.stringify({ message: reason }), {
      status,
      headers: { "content-type": "application/json" },
    });
  };

  app.get("/health", (c) => c.json({ ok: true }));

  // The holder of a capability can end it early; the issuer does so when a run ends.
  app.post("/capabilities/revoke", (c) => {
    const token = capabilityFromHeaders(c.req.raw.headers);
    if (!token) return refuse(401, "missing capability");
    const check = verifyCapability(token, config.signingKey, now(), { allowExpired: true });
    if (!check.ok) return refuse(401, `invalid capability (${check.reason})`);
    ledger.revoke(check.capability);
    log({
      event: "model.relay.revoked",
      status: 204,
      capability: capabilityLabel(check.capability.id),
      run: check.capability.run,
      user: check.capability.user,
    });
    return c.body(null, 204);
  });

  app.use(
    "/model/*",
    bodyLimit({ maxSize: config.maxBodyBytes, onError: () => refuse(413, "request too large") }),
  );

  app.post("/model/*", async (c) => {
    const started = now();
    ledger.prune(started);
    const route = parseRelayPath(new URL(c.req.url).pathname);
    if (!route) return refuse(404, "not a relayed model path");
    const token = capabilityFromHeaders(c.req.raw.headers);
    if (!token) return refuse(401, "missing capability");
    const check = verifyCapability(token, config.signingKey, started);
    if (!check.ok) {
      return refuse(check.reason === "expired" ? 403 : 401, `invalid capability (${check.reason})`);
    }
    const capability = check.capability;
    if (ledger.isRevoked(capability)) return refuse(403, "capability revoked", capability);
    if (route.model !== capability.model || !config.models.includes(route.model)) {
      return refuse(403, "model not allowed", capability);
    }
    const declared = Number(c.req.header("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > config.maxBodyBytes) {
      return refuse(413, "request too large", capability);
    }
    const body = new Uint8Array(await c.req.arrayBuffer());
    if (body.byteLength > config.maxBodyBytes) {
      return refuse(413, "request too large", capability);
    }
    // A slow body can outlast the capability, and an expired one's count may already be
    // pruned, so expiry and revocation are checked again before the allowance is used.
    if (capability.exp <= now()) return refuse(403, "invalid capability (expired)", capability);
    if (ledger.isRevoked(capability)) return refuse(403, "capability revoked", capability);
    if (!ledger.take(capability)) return refuse(429, "request allowance used", capability);
    const credential = await upstreamToken();
    if (!credential) return refuse(503, "relay has no model credential", capability);

    const headers = new Headers();
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = c.req.header(name);
      if (value) headers.set(name, value);
    }
    headers.set("authorization", `Bearer ${credential}`);
    const target = `${config.upstream}/model/${encodeURIComponent(route.model)}/${
      route.stream ? "invoke-with-response-stream" : "invoke"
    }`;

    const base: RelayEvent = {
      event: "model.relayed",
      capability: capabilityLabel(capability.id),
      run: capability.run,
      user: capability.user,
      model: capability.model,
      stream: route.stream,
      status: 0,
      requestBytes: body.byteLength,
    };

    let upstream: Response;
    try {
      upstream = await fetchImpl(target, {
        method: "POST",
        headers,
        body,
        redirect: "error",
        signal: c.req.raw.signal,
      });
    } catch {
      log({ ...base, status: 502, reason: "upstream unreachable", durationMs: now() - started });
      return new Response(JSON.stringify({ message: "upstream unreachable" }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    }

    const responseHeaders = new Headers();
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    // Exactly one event per request: on completion, on an upstream stream error, or
    // when the computer stops reading.
    let responseBytes = 0;
    let logged = false;
    const finish = (reason?: string) => {
      if (logged) return;
      logged = true;
      log({
        ...base,
        status: upstream.status,
        responseBytes,
        durationMs: now() - started,
        ...(reason ? { reason } : {}),
      });
    };
    const reader = upstream.body?.getReader();
    if (!reader) {
      finish();
      return new Response(null, { status: upstream.status, headers: responseHeaders });
    }
    const counted = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            finish();
            controller.close();
            return;
          }
          responseBytes += value.byteLength;
          controller.enqueue(value);
        } catch (error) {
          finish("upstream stream failed");
          controller.error(error);
        }
      },
      async cancel(reason) {
        finish("response cancelled");
        await reader.cancel(reason).catch(() => undefined);
      },
    });
    return new Response(counted, { status: upstream.status, headers: responseHeaders });
  });

  app.all("*", () => refuse(404, "not found"));
  return app;
}
