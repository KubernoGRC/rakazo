import { createHash } from "node:crypto";
import type { ConnectorRoute } from "@rakazo/adapter-kit";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import { recordSecurityEvent } from "@rakazo/db";
import { isToolPauseResult } from "./approval-effect.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import type { ToolRequest } from "./run-tool-request.js";

/**
 * How one tool call ended, as `tool.called` records it:
 * - `ok`: the tool ran and returned a result.
 * - `error`: the tool ran, or tried to, and failed.
 * - `refused`: it never ran. A disabled or unknown tool, a malformed request, or an
 *   approval policy that blocks it.
 * - `replayed`: it did not run again; its gate returned what an earlier attempt of the same
 *   effect already settled. That attempt has its own event.
 * - `approval_requested`: it is waiting for a person to approve it.
 * - `input_requested`: it is waiting for protected input from the owner.
 * - `cancelled`: the run was cancelled while it was in flight.
 */
export type ToolCallOutcome =
  | "ok"
  | "error"
  | "refused"
  | "replayed"
  | "approval_requested"
  | "input_requested"
  | "cancelled";

/**
 * Who let the call run: `person` when an owner approved this exact call, `policy` when a
 * standing rule or the reviewer allowed a call that would otherwise ask, and `none` when it
 * needed no approval.
 */
export type ToolCallApproval = "person" | "policy" | "none";

/** What the dispatcher tells the audit as a call moves through resolution and its gate. */
export interface ToolCallAudit {
  /** The call resolved to the connector tool it runs, if any. */
  resolved(request: ToolRequest): void;
  /** The call passed its approval gate and is about to run. */
  passedGate(call: ToolCall): void;
}

const UNKNOWN_TOOL = "(unknown)";

/**
 * Run one tool call and record a content-free `tool.called` security event for it, however
 * it ends. The event carries identifiers, sizes and a SHA-256 of the arguments, never the
 * arguments or the result. Recording never fails the call.
 */
export async function auditToolCall<T>(
  ctx: RunContext,
  name: string,
  args: Record<string, unknown>,
  knownTool: boolean,
  dispatch: (audit: ToolCallAudit) => Promise<T>,
  now: () => number = Date.now,
): Promise<T> {
  const startedAt = now();
  let route: ConnectorRoute | undefined = ctx.tools.connector.get(name)?.route;
  let passed: ToolCall | undefined;
  const audit: ToolCallAudit = {
    resolved(request) {
      route = request.connectorCall.route ?? route;
    },
    passedGate(call) {
      passed = call;
    },
  };
  const record = async (outcome: ToolCallOutcome, result: unknown) => {
    try {
      await recordSecurityEvent(
        await toolCalledEvent(ctx, {
          name: knownTool ? name : UNKNOWN_TOOL,
          args,
          route,
          call: passed,
          outcome,
          result,
          durationMs: Math.max(0, now() - startedAt),
        }),
      );
    } catch {
      // recordSecurityEvent never throws; building the event must not fail a call either.
    }
  };
  let result: T;
  try {
    result = await dispatch(audit);
  } catch (error) {
    await record(ctx.context.signal.aborted ? "cancelled" : "error", undefined);
    throw error;
  }
  await record(toolCallOutcome(result, passed !== undefined), result);
  return result;
}

/** Classify what a dispatch returned. A call that never passed its gate cannot be `ok`. */
export function toolCallOutcome(result: unknown, ranPastGate: boolean): ToolCallOutcome {
  if (isToolPauseResult(result)) {
    return (result.details as { secret?: unknown }).secret === "paused"
      ? "input_requested"
      : "approval_requested";
  }
  const failed = isErrorResult(result);
  // Before the gate, only an error stops a call; a result there is an earlier attempt's.
  if (!ranPastGate) return failed ? "refused" : "replayed";
  return failed ? "error" : "ok";
}

/** Who let a call that passed its gate run, and the id of the approval a person gave. */
export function toolCallApproval(call: ToolCall | undefined): {
  approval: ToolCallApproval;
  approvalId: string | undefined;
} {
  const effect = call?.applied?.effect;
  if (effect?.status === "approved") return { approval: "person", approvalId: effect.id };
  if (call?.bypassApproval) return { approval: "policy", approvalId: undefined };
  return { approval: "none", approvalId: undefined };
}

/** SHA-256 and UTF-8 size of a value's canonical JSON, or of `null` when there is none. */
export function contentDigest(value: unknown): { sha256: string; bytes: number } {
  const json = canonicalJson(value);
  return {
    sha256: createHash("sha256").update(json, "utf8").digest("hex"),
    bytes: Buffer.byteLength(json, "utf8"),
  };
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  try {
    return stableJsonValue(value);
  } catch {
    // Not plain JSON (a Date, a class instance, a cycle). Still hash something stable.
    try {
      return JSON.stringify(value) ?? "null";
    } catch {
      return "null";
    }
  }
}

/**
 * The host a call reached: the hostname of a remote MCP server's endpoint, or `stdio:` and the
 * command and package of a local one. Other connectors have no single host and get none.
 */
export async function toolCallHost(
  ctx: RunContext,
  route: ConnectorRoute | undefined,
): Promise<string | undefined> {
  if (route?.connectorId !== "mcp" || !route.resourceId) return undefined;
  const hosts = mcpHostCache(ctx);
  const cached = hosts.get(route.resourceId);
  if (cached) return cached;
  const lookup = ctx.deps.prisma.mcpServer
    .findFirst({
      where: { id: route.resourceId, spaceId: ctx.run.spaceId },
      select: { transport: true, endpoint: true, command: true, args: true },
    })
    .then((server) => (server ? mcpServerHost(server) : undefined))
    .catch(() => undefined);
  hosts.set(route.resourceId, lookup);
  return lookup;
}

const PACKAGE_NAME = /^@?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?(?:@[a-z0-9._-]+)?$/i;

/** A stable, secret-free name for an MCP server, from its stored transport settings. */
export function mcpServerHost(server: {
  transport: string;
  endpoint: string | null;
  command: string | null;
  args: unknown;
}): string | undefined {
  if (server.endpoint) {
    try {
      return new URL(server.endpoint).hostname.toLowerCase() || undefined;
    } catch {
      return undefined;
    }
  }
  if (!server.command) return undefined;
  const command = server.command.split(/[\\/]/).at(-1) ?? server.command;
  // Only the first positional argument, and only when it reads as a package name: flags and
  // later arguments can carry tokens.
  const first = Array.isArray(server.args)
    ? server.args.find((arg): arg is string => typeof arg === "string" && !arg.startsWith("-"))
    : undefined;
  const pkg = first && PACKAGE_NAME.test(first) ? ` ${first}` : "";
  return `stdio:${command}${pkg}`.slice(0, 200);
}

const hostCaches = new WeakMap<RunContext, Map<string, Promise<string | undefined>>>();

function mcpHostCache(ctx: RunContext) {
  let cache = hostCaches.get(ctx);
  if (!cache) {
    cache = new Map();
    hostCaches.set(ctx, cache);
  }
  return cache;
}

async function toolCalledEvent(
  ctx: RunContext,
  input: {
    name: string;
    args: Record<string, unknown>;
    route: ConnectorRoute | undefined;
    call: ToolCall | undefined;
    outcome: ToolCallOutcome;
    result: unknown;
    durationMs: number;
  },
) {
  const { run } = ctx;
  const args = contentDigest(input.args);
  const result = input.outcome === "ok" || input.outcome === "error" ? input.result : undefined;
  const { approval, approvalId } = toolCallApproval(input.call);
  return {
    type: "tool.called" as const,
    userId: run.userId,
    spaceId: run.spaceId,
    metadata: {
      tool: input.name,
      connector: input.route?.connectorId,
      remoteTool: input.route ? input.route.toolName : undefined,
      resourceId: input.route?.resourceId,
      host: await toolCallHost(ctx, input.route),
      argsSha256: args.sha256,
      argsBytes: args.bytes,
      resultBytes: result === undefined ? undefined : contentDigest(result).bytes,
      outcome: input.outcome,
      approval,
      approvalId,
      runId: ctx.runId,
      threadId: run.threadId,
      botId: run.botId,
      durationMs: input.durationMs,
    },
  };
}

function isErrorResult(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    !Array.isArray(result) &&
    typeof (result as { error?: unknown }).error === "string"
  );
}
