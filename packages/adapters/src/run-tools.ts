import type { AgentToolExecutionObserver } from "@rakazo/adapter-kit";
import { toolResultTaintsRun } from "@rakazo/core";
import { IMAGE_RETURNING_COMPUTER_TOOLS, MODEL_CANNOT_SEE_MESSAGE } from "./model-vision.js";
import type { RunContext } from "./run-context.js";
import { pauseForApproval } from "./run-context.js";
import type { ToolHandler } from "./run-tool-gate.js";
import { gateToolCall } from "./run-tool-gate.js";
import { prepareToolRequest, resolveToolRequest } from "./run-tool-request.js";
import { PAGE_BROWSER_TOOL_NAMES } from "./run-tool-selection.js";
import { computerTools, pageBrowserTool } from "./run-tools-computer.js";
import { fileTools } from "./run-tools-files.js";
import { fleetTools } from "./run-tools-fleet.js";
import { cloudAgentTool, connectorTool, integrationTools } from "./run-tools-integrations.js";
import { memoryTools } from "./run-tools-memory.js";
import { messagingTools } from "./run-tools-messaging.js";
import { secretTools } from "./run-tools-secrets.js";
import { taskTools } from "./run-tools-tasks.js";
import type { ToolCallAudit } from "./tool-call-event.js";
import { auditToolCall } from "./tool-call-event.js";

const TOOL_HANDLERS = new Map<string, ToolHandler>([
  ...Object.entries(computerTools),
  ...Object.entries(fileTools),
  ...Object.entries(memoryTools),
  ...Object.entries(integrationTools),
  ...Object.entries(taskTools),
  ...Object.entries(messagingTools),
  ...Object.entries(secretTools),
  ...Object.entries(fleetTools),
  ...[...PAGE_BROWSER_TOOL_NAMES].map((name) => [name, pageBrowserTool] as const),
]);

function toolHandler(name: string): ToolHandler {
  return (
    TOOL_HANDLERS.get(name) ?? (name.startsWith("cloud_agent_") ? cloudAgentTool : connectorTool)
  );
}

/**
 * Run one tool call of this run's model: gate it, then hand it to its tool family. Every call,
 * however it ends, records one `tool.called` security event.
 */
export async function applyTool(
  ctx: RunContext,
  name: string,
  args: Record<string, unknown>,
  executionId: string,
  _route?: unknown,
  observer?: AgentToolExecutionObserver,
) {
  const knownTool =
    TOOL_HANDLERS.has(name) ||
    ctx.tools.connector.has(name) ||
    ctx.tools.builtins.some((tool) => tool.name === name);
  try {
    return await auditToolCall(ctx, name, args, knownTool, (audit) =>
      dispatchOneTool(ctx, name, args, executionId, observer, audit),
    );
  } finally {
    if (toolResultTaintsRun(name)) ctx.state.tainted = true;
  }
}

async function dispatchOneTool(
  ctx: RunContext,
  name: string,
  args: Record<string, unknown>,
  executionId: string,
  observer: AgentToolExecutionObserver | undefined,
  audit: ToolCallAudit,
) {
  if (name !== "propose_instructions_update")
    return dispatchTool(ctx, name, args, executionId, observer, audit);
  const { approval } = ctx.state;
  if (approval.proposalInFlight)
    return { error: "This bot already has a pending instruction proposal." };
  approval.proposalInFlight = true;
  try {
    return await dispatchTool(ctx, name, args, executionId, observer, audit);
  } finally {
    approval.proposalInFlight = false;
  }
}

async function dispatchTool(
  ctx: RunContext,
  name: string,
  args: Record<string, unknown>,
  executionId: string,
  observer: AgentToolExecutionObserver | undefined,
  audit: ToolCallAudit,
) {
  ctx.context.signal.throwIfAborted();
  if (ctx.state.handedOff) {
    return {
      error: "This stage was handed off. End the turn without more tool calls.",
    };
  }
  if (name === "propose_instructions_update" && ctx.state.approval.pausePending)
    return pauseForApproval(ctx);
  if (ctx.tools.disabled.has(name)) {
    return { error: "This tool is disabled for this bot." };
  }
  if (PAGE_BROWSER_TOOL_NAMES.has(name) && !ctx.computer.pageBrowserAllowed) {
    return { error: "Page browser is unavailable on this computer." };
  }
  if (IMAGE_RETURNING_COMPUTER_TOOLS.has(name) && !ctx.computer.acceptsImages) {
    return { error: MODEL_CANNOT_SEE_MESSAGE };
  }
  const request = await resolveToolRequest(ctx, name, args, executionId);
  if ("error" in request) return request;
  audit.resolved(request);
  const refused = await prepareToolRequest(ctx, request);
  if (refused) return refused;
  const gate = await gateToolCall(ctx, request, observer);
  if ("result" in gate) {
    if (gate.replayed) audit.replayed();
    return gate.result;
  }
  audit.passedGate(gate.call);
  return toolHandler(gate.call.name)(ctx, gate.call);
}
