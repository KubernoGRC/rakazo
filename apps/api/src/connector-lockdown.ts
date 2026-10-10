import { ORPCError } from "@orpc/server";

/** RPCs that let a user add their own MCP servers or connectors. */
export function isLockedDownRpcPath(path: readonly string[]): boolean {
  const [scope, name] = path;
  return (
    scope === "mcp" ||
    (scope === "capabilities" && name === "install") ||
    (scope === "integrationSetup" && name === "save")
  );
}

/** Client interceptor for a lock-down deployment; runs before auth and input parsing. */
export async function rejectLockedDownRpc<T>(options: {
  path: readonly string[];
  next: () => T;
}): Promise<Awaited<T>> {
  if (isLockedDownRpcPath(options.path)) {
    throw new ORPCError("FORBIDDEN", { message: "Disabled on this deployment" });
  }
  return await options.next();
}
