// Fork-owned (see docs/kgrc-fork.md): operator-pinned private MCP hosts, kept out of
// remote-mcp.ts so upstream changes to that file rarely touch fork lines.
import {
  ConnectionSetupError,
  ipVersion,
  isCloudMetadataAddress,
  isLinkLocalAddress,
  isLoopbackAddress,
} from "@rakazo/contracts";
import type { ResolvedAddress, ResolveHostname } from "../network/network-address.js";

export interface PinnedPrivateHostPolicy {
  /**
   * One exact DNS name a deployment-owned connector may reach on private addresses,
   * such as a private service endpoint. Only that name is exempt: it still needs HTTPS,
   * and every address it resolves to must be RFC 1918 IPv4 or IPv6 unique-local
   * (fd00::/8), never cloud metadata, link-local or loopback. Every other host keeps
   * the default policy.
   */
  privateEndpointHost?: string;
  /** Exact DNS names an operator lets user-configured servers reach on private
   * addresses, each under the same rules as `privateEndpointHost`. */
  privateEndpointHosts?: readonly string[];
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "");
}

/** Exact match only: no suffix, wildcard or IP-literal pins. */
export function isPinnedPrivateHost(hostname: string, policy: PinnedPrivateHostPolicy): boolean {
  const host = normalizeHostname(hostname);
  return [policy.privateEndpointHost, ...(policy.privateEndpointHosts ?? [])].some((entry) => {
    const pin = entry ? normalizeHostname(entry) : "";
    return pin !== "" && ipVersion(pin) === 0 && host === pin;
  });
}

/** RFC 1918 IPv4 or locally assigned IPv6 unique-local (fd00::/8) only. Cloud
 * metadata, link-local and loopback are refused first, because AWS serves its IPv6
 * metadata endpoint (fd00:ec2::254) from inside fd00::/8. Being an allowlist, it also
 * refuses CGNAT and transition-encoded forms (NAT64, 6to4). */
function isPinnablePrivateAddress(value: string): boolean {
  const address = value.toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "");
  if (
    isCloudMetadataAddress(address) ||
    isLinkLocalAddress(address) ||
    isLoopbackAddress(address)
  ) {
    return false;
  }
  if (ipVersion(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168);
  }
  if (ipVersion(address) !== 6) return false;
  const first = address.split(":")[0] ?? "";
  return first.length === 4 && (Number.parseInt(first, 16) & 0xff00) === 0xfd00;
}

export function assertPinnedPrivateAddresses(addresses: ResolvedAddress[]): void {
  if (
    addresses.length === 0 ||
    addresses.some((entry) => !isPinnablePrivateAddress(entry.address))
  ) {
    throw new Error("Private endpoint must resolve only to private addresses");
  }
}

/** The URL policy a connector's options carry, pinned private hosts included. */
export function remoteUrlPolicy(
  options: PinnedPrivateHostPolicy & { allowPrivateEndpoint?: boolean },
): PinnedPrivateHostPolicy & { allowPrivateEndpoint?: boolean } {
  return {
    allowPrivateEndpoint: options.allowPrivateEndpoint,
    privateEndpointHost: options.privateEndpointHost,
    privateEndpointHosts: options.privateEndpointHosts,
  };
}

/**
 * Checks a connector URL whose host is pinned: HTTPS only, and every resolved address must be
 * pinnable. Returns undefined for any other host, which keeps the default policy.
 */
export async function inspectPinnedUrl(
  url: URL,
  hostname: string,
  policy: PinnedPrivateHostPolicy,
  resolve: ResolveHostname,
): Promise<{ url: URL; addresses: ResolvedAddress[] } | undefined> {
  if (!isPinnedPrivateHost(hostname, policy)) return undefined;
  if (url.protocol !== "https:") throw new ConnectionSetupError("Connector URL must use HTTPS");
  const addresses = await resolve(hostname);
  assertPinnedPrivateAddresses(addresses);
  return { url, addresses };
}

/**
 * Applies the pinned-host address rule when `hostname` is pinned: returns true once every
 * address passes (and throws otherwise), or false for any other host.
 */
export function pinnedAddressesChecked(
  hostname: string,
  addresses: ResolvedAddress[],
  policy: PinnedPrivateHostPolicy,
): boolean {
  if (!isPinnedPrivateHost(hostname, policy)) return false;
  assertPinnedPrivateAddresses(addresses);
  return true;
}
