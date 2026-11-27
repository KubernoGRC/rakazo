import type { AccessVerdict, AccessVerifier } from "@rakazo/auth";
import type { PrismaClient } from "@rakazo/db";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createForkAccess } from "./access-identity-wiring.js";

const keys = vi.hoisted(() => ({ ready: true }));

/** Accepts exactly the assertion `valid:<subject>`; the real checks are tested in @rakazo/auth. */
vi.mock("@rakazo/auth", async (original) => ({
  ...(await original<typeof import("@rakazo/auth")>()),
  createAccessVerifier: (): AccessVerifier => ({
    ready: async () => keys.ready,
    verify: async (headers): Promise<AccessVerdict> => {
      const value = headers.get("cf-access-jwt-assertion");
      if (!value) return { ok: false, reason: "missing" };
      return value.startsWith("valid:")
        ? { ok: true, email: "person@example.test", subject: value.slice(6), issuedAt: undefined }
        : { ok: false, reason: "bad_signature" };
    },
  }),
}));

const config = {
  issuer: "https://issuer.example.test",
  audience: "aud",
  certsFile: "/nonexistent",
};

function fakes(linked: string | undefined) {
  const deleted: string[] = [];
  const ended: string[] = [];
  const prisma = {
    account: { findFirst: async () => (linked ? { accountId: linked } : null) },
    session: {
      deleteMany: async ({ where }: { where: { id: string } }) => {
        deleted.push(where.id);
      },
    },
  } as unknown as PrismaClient;
  const pushTokens = {
    endSession: async (_userId: string, sessionId: string) => {
      ended.push(sessionId);
    },
  };
  return { prisma, pushTokens, deleted, ended };
}

const current = { session: { id: "s1", userId: "u1" }, user: { id: "u1" } };
const asserted = (subject: string) =>
  new Request("http://api.test/rpc", {
    headers: { "cf-access-jwt-assertion": `valid:${subject}` },
  });

describe("fork access identity wiring", () => {
  it("adds nothing when access identity is off", async () => {
    const { prisma, pushTokens } = fakes(undefined);
    const fork = createForkAccess({}, { prisma, pushTokens });
    expect(fork.verifier).toBeUndefined();
    expect(fork.capabilities).toEqual({});
    expect(fork.unready).toBeUndefined();
    const app = new Hono();
    fork.mountGate(app);
    app.get("/x", (c) => c.text("reached"));
    expect(await (await app.request("/x")).text()).toBe("reached");
    const read = fork.bindSession(async () => current);
    expect(await read(new Request("http://api.test/"))).toBe(current);
    const getSession = vi.fn();
    await fork.beforeAuthHandler(new Request("http://api.test/"), getSession);
    expect(getSession).not.toHaveBeenCalled();
  });

  it("reads a session without a user as none", async () => {
    const { prisma, pushTokens } = fakes(undefined);
    const read = createForkAccess({}, { prisma, pushTokens }).bindSession(async () => ({
      session: { id: "s1", userId: "u1" },
    }));
    expect(await read(new Request("http://api.test/"))).toBeNull();
  });

  it("reports capabilities, readiness and the gate when access identity is on", async () => {
    const { prisma, pushTokens } = fakes("subject-1");
    const fork = createForkAccess(
      { accessIdentity: { ...config, logoutUrl: "/logout" } },
      { prisma, pushTokens },
    );
    expect(fork.verifier).toBeDefined();
    expect(fork.capabilities).toEqual({ accessIdentity: true, accessLogoutUrl: "/logout" });
    keys.ready = true;
    expect(await fork.unready?.()).toBeUndefined();
    keys.ready = false;
    expect(await fork.unready?.()).toBe("access_identity_keys_unavailable");
    keys.ready = true;
    const app = new Hono();
    fork.mountGate(app);
    app.get("/x", (c) => c.text("reached"));
    expect((await app.request("/x")).status).toBe(401);
    expect((await app.request(asserted("subject-1"))).status).toBe(404);
  });

  it("keeps a session only for its linked subject and ends it otherwise", async () => {
    const { prisma, pushTokens, deleted, ended } = fakes("subject-1");
    const fork = createForkAccess({ accessIdentity: config }, { prisma, pushTokens });
    const read = fork.bindSession(async () => current);
    expect(await read(asserted("subject-1"))).toBe(current);
    expect(await read(asserted("subject-2"))).toBeNull();
    expect(deleted).toEqual(["s1"]);
    expect(ended).toEqual(["s1"]);
  });

  it("ends a foreign session before the auth handler runs", async () => {
    const { prisma, pushTokens, deleted } = fakes("subject-1");
    const fork = createForkAccess({ accessIdentity: config }, { prisma, pushTokens });
    await fork.beforeAuthHandler(asserted("subject-1"), async () => current);
    expect(deleted).toEqual([]);
    await fork.beforeAuthHandler(asserted("subject-2"), async () => current);
    expect(deleted).toEqual(["s1"]);
  });
});
