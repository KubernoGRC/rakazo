/**
 * Fork-owned (see docs/kgrc-fork.md): the desktop app refuses a server whose only sign-in is
 * an access proxy's browser flow. Kept out of main.ts, which wraps its probe with this.
 */
import type { DesktopReachability } from "@rakazo/contracts";
import { net } from "electron";
import { PROBE_TIMEOUT_MS } from "../windows/app-window.js";
import {
  ACCESS_IDENTITY_DESKTOP_MESSAGE,
  normalizeServerUrl,
  readProbeJson,
  usesAccessIdentity,
} from "./setup-config.js";

type Probe<A extends unknown[]> = (
  rawUrl: string,
  signal?: AbortSignal,
  ...rest: A
) => Promise<DesktopReachability>;

/**
 * Checks `/api/auth/capabilities` before the wrapped probe runs. It goes first, because that
 * mode answers the health probe with 401 while capabilities is exempt. Anything else, including
 * a capabilities request that fails, is left to the wrapped probe to report.
 */
export function refuseAccessIdentityServers<A extends unknown[]>(
  probe: Probe<A>,
  fetch: (url: string, init: RequestInit) => Promise<Response> = (url, init) =>
    net.fetch(url, init),
): Probe<A> {
  return async (rawUrl, signal, ...rest) => {
    const url = normalizeServerUrl(rawUrl);
    if (url === null) return probe(rawUrl, signal, ...rest);
    const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);
    try {
      const capabilities = await fetch(`${url}/api/auth/capabilities`, {
        cache: "no-store",
        credentials: "omit",
        redirect: "manual",
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      });
      if (capabilities.ok && usesAccessIdentity(await readProbeJson(capabilities))) {
        return {
          ok: false,
          status: capabilities.status,
          url,
          error: ACCESS_IDENTITY_DESKTOP_MESSAGE,
        };
      }
    } catch {
      return probe(rawUrl, signal, ...rest);
    }
    return probe(rawUrl, signal, ...rest);
  };
}
