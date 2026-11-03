import { createHmac, randomBytes } from "node:crypto";

/**
 * Fork patch: issues the per-run capability an isolated computer presents to
 * the model relay (docs/fork-computer-model-relay.md). The format is verified
 * by infra/sandboxes/supervisor/src/model-relay-logic.ts. Both test suites
 * assert the same fixed vector.
 */

export const RELAY_CAPABILITY_PREFIX = "rkc1";

export interface RelayCapabilityClaims {
  id: string;
  run: string;
  user: string;
  model: string;
  exp: number;
  max: number;
}

export function signRelayCapabilityPayload(encodedPayload: string, key: string) {
  return createHmac("sha256", key)
    .update(`${RELAY_CAPABILITY_PREFIX}.${encodedPayload}`)
    .digest("base64url");
}

export function encodeRelayCapability(claims: RelayCapabilityClaims, key: string) {
  const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${RELAY_CAPABILITY_PREFIX}.${encoded}.${signRelayCapabilityPayload(encoded, key)}`;
}

export function issueRelayCapability(input: {
  key: string;
  run: string;
  user: string;
  model: string;
  ttlMs: number;
  max: number;
  now?: number;
}) {
  if (input.key.length < 32) throw new Error("the relay signing key must be 32+ characters");
  const claims: RelayCapabilityClaims = {
    id: randomBytes(16).toString("hex"),
    run: input.run,
    user: input.user,
    model: input.model,
    exp: (input.now ?? Date.now()) + input.ttlMs,
    max: input.max,
  };
  return { token: encodeRelayCapability(claims, input.key), claims };
}
