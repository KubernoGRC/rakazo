import type { DesktopReachability } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { refuseAccessIdentityServers } from "./access-identity-probe.js";
import { ACCESS_IDENTITY_DESKTOP_MESSAGE } from "./setup-config.js";

vi.mock("electron", () => ({ net: { fetch: vi.fn() }, app: { isPackaged: true } }));
vi.mock("../windows/app-window.js", () => ({ PROBE_TIMEOUT_MS: 1_000 }));

const reachable: DesktopReachability = { ok: true, url: "https://server.example.test" };

function wrapped(answer: () => Promise<Response>) {
  const probe = vi.fn(async (_url: string, _signal?: AbortSignal) => reachable);
  const fetch = vi.fn(answer);
  return { probe, fetch, screened: refuseAccessIdentityServers(probe, fetch) };
}

describe("refuseAccessIdentityServers", () => {
  it("refuses a server whose capabilities report access identity, without probing it", async () => {
    const { probe, fetch, screened } = wrapped(async () => Response.json({ accessIdentity: true }));
    const result = await screened("https://server.example.test");
    expect(result).toEqual({
      ok: false,
      status: 200,
      url: "https://server.example.test",
      error: ACCESS_IDENTITY_DESKTOP_MESSAGE,
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://server.example.test/api/auth/capabilities",
      expect.objectContaining({ credentials: "omit", redirect: "manual" }),
    );
    expect(probe).not.toHaveBeenCalled();
  });

  it("hands any other server to the wrapped probe", async () => {
    const { probe, screened } = wrapped(async () => Response.json({ passwordAuth: true }));
    expect(await screened("https://server.example.test")).toBe(reachable);
    expect(probe).toHaveBeenCalledOnce();
  });

  it("leaves a failed capabilities request and an invalid address to the wrapped probe", async () => {
    const failing = wrapped(async () => {
      throw new Error("offline");
    });
    expect(await failing.screened("https://server.example.test")).toBe(reachable);
    const invalid = wrapped(async () => Response.json({}));
    expect(await invalid.screened("not a url")).toBe(reachable);
    expect(invalid.fetch).not.toHaveBeenCalled();
  });
});
