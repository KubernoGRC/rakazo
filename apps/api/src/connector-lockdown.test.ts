import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import { appContract } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { isLockedDownRpcPath, rejectLockedDownRpc } from "./connector-lockdown.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: true,
} satisfies Actor;

function contractPaths(node: unknown, prefix: string[] = []): string[][] {
  if (!node || typeof node !== "object") return [];
  if ("~orpc" in node) return [prefix];
  return Object.entries(node).flatMap(([key, child]) => contractPaths(child, [...prefix, key]));
}

const allPaths = contractPaths(appContract);
const lockedPaths = allPaths.filter(isLockedDownRpcPath);

/** The real router over a database that records any access, so a refusal provably ran first. */
function handler(lockdown: boolean) {
  const touched: string[] = [];
  const prisma = new Proxy(
    {},
    {
      get(_target, model) {
        touched.push(String(model));
        throw new Error("database reached");
      },
    },
  );
  const deps = {
    prisma: prisma as unknown as PrismaClient,
    env: {
      defaultProvider: "fake",
      defaultModel: "fake-model",
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "fake-test-secret",
      sandboxProvider: "fake",
    },
    dataDir: "/tmp/rakazo-lockdown-test",
  } as unknown as RouterDeps;
  const rpc = new RPCHandler(createRouter(deps), {
    clientInterceptors: [...(lockdown ? [rejectLockedDownRpc] : []), onError(() => undefined)],
  });
  async function call(path: string[]) {
    const { response } = await rpc.handle(
      new Request(`http://127.0.0.1/rpc/${path.join("/")}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: {} }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    if (!response) throw new Error(`No procedure at ${path.join(".")}`);
    const body = (await response.json()) as { json?: { code?: string } };
    return { status: response.status, code: body.json?.code };
  }
  return { call, touched };
}

describe("connector lock-down", () => {
  it("covers capabilities.install, integrationSetup.save and every mcp procedure", () => {
    const names = lockedPaths.map((path) => path.join("."));
    expect(names).toContain("capabilities.install");
    expect(names).toContain("integrationSetup.save");
    expect(names).toContain("mcp.servers.create");
    expect(names.filter((name) => name.startsWith("mcp."))).toEqual(
      allPaths.map((path) => path.join(".")).filter((name) => name.startsWith("mcp.")),
    );
    expect(names).not.toContain("capabilities.list");
    expect(names).not.toContain("integrationSetup.get");
  });

  it.each(lockedPaths.map((path) => [path.join("."), path] as const))(
    "rejects %s before it reaches the handler",
    async (_name, path) => {
      const { call, touched } = handler(true);
      await expect(call(path)).resolves.toEqual({ status: 403, code: "FORBIDDEN" });
      expect(touched).toEqual([]);
    },
  );

  it("leaves other procedures alone", async () => {
    const { call, touched } = handler(true);
    const result = await call(["capabilities", "list"]);
    expect(result.code).not.toBe("FORBIDDEN");
    expect(touched.length).toBeGreaterThan(0);
  });

  it("does nothing when the deployment is not locked down", async () => {
    const { call, touched } = handler(false);
    const result = await call(["mcp", "servers", "list"]);
    expect(result.code).not.toBe("FORBIDDEN");
    expect(touched.length).toBeGreaterThan(0);
  });
});
