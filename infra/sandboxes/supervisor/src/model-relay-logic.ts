import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Fork patch: the model relay's pure parts. A computer with isolated egress
 * (docs/fork-isolated-computer-egress.md) reaches the relay as a network peer
 * and presents a per-run capability. The relay checks it and forwards the call
 * to the model endpoint with the deployment's own credential, which never
 * enters the computer. See docs/fork-computer-model-relay.md.
 *
 * The capability format is shared with the issuer in
 * packages/adapters/src/model-relay-capability.ts. Both test suites assert the
 * same fixed vector, so the two can't drift apart.
 */

export const CAPABILITY_PREFIX = "rkc1";

export interface RelayCapability {
  /** Random id, unique per capability. */
  id: string;
  run: string;
  user: string;
  /** The one model id this capability may invoke. */
  model: string;
  /** Expiry, milliseconds since the epoch. */
  exp: number;
  /** Maximum number of model requests. */
  max: number;
}

export type CapabilityCheck =
  | { ok: true; capability: RelayCapability }
  | { ok: false; reason: "malformed" | "signature" | "expired" };

function base64url(input: Buffer | string) {
  return Buffer.from(input).toString("base64url");
}

export function signCapabilityPayload(encodedPayload: string, key: string) {
  return base64url(
    createHmac("sha256", key).update(`${CAPABILITY_PREFIX}.${encodedPayload}`).digest(),
  );
}

function isCapability(value: unknown): value is RelayCapability {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    v.id.length >= 16 &&
    typeof v.run === "string" &&
    v.run.length > 0 &&
    typeof v.user === "string" &&
    v.user.length > 0 &&
    typeof v.model === "string" &&
    v.model.length > 0 &&
    typeof v.exp === "number" &&
    Number.isFinite(v.exp) &&
    typeof v.max === "number" &&
    Number.isInteger(v.max) &&
    v.max > 0
  );
}

/** Verify a capability's signature, shape and (unless `allowExpired`) expiry. */
export function verifyCapability(
  token: string,
  key: string,
  now: number,
  options: { allowExpired?: boolean } = {},
): CapabilityCheck {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== CAPABILITY_PREFIX || !parts[1] || !parts[2]) {
    return { ok: false, reason: "malformed" };
  }
  const expected = Buffer.from(signCapabilityPayload(parts[1], key));
  const given = Buffer.from(parts[2]);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: "signature" };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!isCapability(payload)) return { ok: false, reason: "malformed" };
  if (!options.allowExpired && payload.exp <= now) return { ok: false, reason: "expired" };
  return { ok: true, capability: payload };
}

/** A short, non-reversible label for logs; the capability itself is never logged. */
export function capabilityLabel(id: string) {
  return createHash("sha256").update(id).digest("hex").slice(0, 16);
}

/** The bearer capability from `Authorization: Bearer` or `x-rakazo-capability`. */
export function capabilityFromHeaders(headers: Headers): string | undefined {
  const explicit = headers.get("x-rakazo-capability")?.trim();
  if (explicit) return explicit;
  const authorization = headers.get("authorization")?.trim();
  const match = authorization ? /^Bearer\s+(\S+)$/i.exec(authorization) : null;
  return match?.[1];
}

export type RelayRoute = { model: string; stream: boolean };

/**
 * The only paths the relay forwards: Bedrock runtime's InvokeModel and
 * InvokeModelWithResponseStream. Anything else is refused.
 */
export function parseRelayPath(pathname: string): RelayRoute | undefined {
  const match = /^\/model\/([^/]+)\/(invoke|invoke-with-response-stream)$/.exec(pathname);
  if (!match?.[1]) return undefined;
  let model: string;
  try {
    model = decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
  // The model must also equal the capability's exactly; this only rejects junk.
  // A slash is allowed only inside an ARN (an inference profile, sent encoded).
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters
  if (!model || /[\u0000-\u001f\u007f\s]/.test(model)) return undefined;
  if (model.includes("/") && !model.startsWith("arn:")) return undefined;
  return { model, stream: match[2] === "invoke-with-response-stream" };
}

/** Request headers passed upstream. Credentials and everything else are dropped. */
export const FORWARDED_REQUEST_HEADERS = [
  "content-type",
  "accept",
  "x-amzn-bedrock-accept",
  "x-amzn-bedrock-content-type",
] as const;

/** Response headers passed back to the computer. */
export const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "x-amzn-requestid",
  "x-amzn-bedrock-content-type",
] as const;

export interface ModelRelayConfig {
  signingKey: string;
  upstream: string;
  models: string[];
  /** Static upstream token, or a file re-read on every request so rotation needs no restart. */
  upstreamToken?: string;
  upstreamTokenFile?: string;
  maxBodyBytes: number;
  host: string;
  port: number;
}

const DEFAULT_MAX_BODY_BYTES = 20 * 1024 * 1024;

export function modelRelayConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ModelRelayConfig {
  const signingKey = env.MODEL_RELAY_SIGNING_KEY?.trim() ?? "";
  if (signingKey.length < 32) {
    throw new Error("MODEL_RELAY_SIGNING_KEY must be at least 32 characters");
  }
  const region = env.AWS_REGION?.trim();
  const upstream =
    env.MODEL_RELAY_UPSTREAM?.trim() ||
    (region ? `https://bedrock-runtime.${region}.amazonaws.com` : "");
  let url: URL;
  try {
    url = new URL(upstream);
  } catch {
    throw new Error("MODEL_RELAY_UPSTREAM (or AWS_REGION) must give an https URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("MODEL_RELAY_UPSTREAM must be an https URL with no credentials or query");
  }
  const models = (env.MODEL_RELAY_MODELS ?? "")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  if (models.length === 0) throw new Error("MODEL_RELAY_MODELS must list at least one model id");
  const upstreamToken = env.AWS_BEARER_TOKEN_BEDROCK?.trim() || undefined;
  const upstreamTokenFile = env.MODEL_RELAY_UPSTREAM_TOKEN_FILE?.trim() || undefined;
  if (!upstreamToken && !upstreamTokenFile) {
    throw new Error("Set AWS_BEARER_TOKEN_BEDROCK or MODEL_RELAY_UPSTREAM_TOKEN_FILE");
  }
  const maxBodyBytes = Number(env.MODEL_RELAY_MAX_BODY_BYTES ?? DEFAULT_MAX_BODY_BYTES);
  const port = Number(env.MODEL_RELAY_PORT ?? 8790);
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new Error("MODEL_RELAY_MAX_BODY_BYTES must be a positive integer");
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("MODEL_RELAY_PORT must be a TCP port");
  }
  return {
    signingKey,
    upstream: url.origin,
    models: [...new Set(models)],
    upstreamToken,
    upstreamTokenFile,
    maxBodyBytes,
    host: env.MODEL_RELAY_HOST?.trim() || "0.0.0.0",
    port,
  };
}

/**
 * In-memory request counts and revocations, keyed by capability id. Entries
 * are dropped once their capability has expired, since an expired capability
 * is refused anyway. A relay restart forgets counts and revocations, so the
 * capability's expiry is the bound that always holds.
 */
export class CapabilityLedger {
  private readonly counts = new Map<string, { count: number; exp: number }>();
  private readonly revoked = new Map<string, number>();

  isRevoked(capability: RelayCapability) {
    return this.revoked.has(capability.id);
  }

  revoke(capability: RelayCapability) {
    this.revoked.set(capability.id, capability.exp);
  }

  /** Count one request; false when the capability has used its allowance. */
  take(capability: RelayCapability): boolean {
    const entry = this.counts.get(capability.id) ?? { count: 0, exp: capability.exp };
    if (entry.count >= capability.max) return false;
    entry.count += 1;
    this.counts.set(capability.id, entry);
    return true;
  }

  prune(now: number) {
    for (const [id, entry] of this.counts) if (entry.exp <= now) this.counts.delete(id);
    for (const [id, exp] of this.revoked) if (exp <= now) this.revoked.delete(id);
  }
}
