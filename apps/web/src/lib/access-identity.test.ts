import { afterEach, expect, it, vi } from "vitest";
import { signInWithAccessIdentity } from "./access-identity";

afterEach(() => vi.unstubAllGlobals());

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
