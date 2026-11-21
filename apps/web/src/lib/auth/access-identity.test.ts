import { afterEach, expect, it, vi } from "vitest";
import { leaveThroughAccessLogout, signInWithAccessIdentity } from "./access-identity";
import { fetchAuthCapabilities } from "./auth-capabilities";

vi.mock("./auth-capabilities", () => ({ fetchAuthCapabilities: vi.fn() }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(fetchAuthCapabilities).mockReset();
});

function respond(status: number, body: unknown = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

it("reports a new account", async () => {
  respond(200, { created: true });
  expect(await signInWithAccessIdentity()).toEqual({ kind: "signed-in", created: true });
});

it.each([401, 403])("treats %i as a refusal", async (status) => {
  respond(status);
  expect(await signInWithAccessIdentity()).toEqual({ kind: "refused" });
});

it.each([500, 502, 503, 429])("treats %i as transient", async (status) => {
  respond(status);
  expect(await signInWithAccessIdentity()).toEqual({ kind: "unavailable" });
});

it("treats a network failure as transient", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }),
  );
  expect(await signInWithAccessIdentity()).toEqual({ kind: "unavailable" });
});

function capabilities(extra: Record<string, unknown>) {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue({
    sso: null,
    passwordAuth: false,
    passwordReset: false,
    resetUrl: null,
    ...extra,
  });
}

function stubLocation() {
  const assign = vi.fn();
  vi.stubGlobal("window", { location: { assign } });
  return assign;
}

it("continues to the access proxy's logout after a successful sign-out", async () => {
  capabilities({ accessIdentity: true, accessLogoutUrl: "https://team.example.test/logout" });
  const assign = stubLocation();
  expect(await leaveThroughAccessLogout(true)).toBe(true);
  expect(assign).toHaveBeenCalledWith("https://team.example.test/logout");
});

it("stays in the app when the sign-out failed", async () => {
  capabilities({ accessIdentity: true, accessLogoutUrl: "https://team.example.test/logout" });
  const assign = stubLocation();
  expect(await leaveThroughAccessLogout(false)).toBe(false);
  expect(assign).not.toHaveBeenCalled();
});

it.each([
  ["no logout URL", { accessIdentity: true }],
  ["access identity off", { accessLogoutUrl: "https://team.example.test/logout" }],
])("stays in the app with %s", async (_label, extra) => {
  capabilities(extra);
  const assign = stubLocation();
  expect(await leaveThroughAccessLogout(true)).toBe(false);
  expect(assign).not.toHaveBeenCalled();
});

it("stays in the app when capabilities can't load", async () => {
  vi.mocked(fetchAuthCapabilities).mockRejectedValue(new Error("offline"));
  const assign = stubLocation();
  expect(await leaveThroughAccessLogout(true)).toBe(false);
  expect(assign).not.toHaveBeenCalled();
});
