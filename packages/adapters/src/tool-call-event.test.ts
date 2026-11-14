import type { ConnectorTool } from "@rakazo/adapter-kit";
import type * as DbModule from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { approvalPausedToolResult, DENIED_ACTION_ERROR } from "./approval-effect.js";
import {
  SUBAGENT_FAILURE_PREFIX,
  SUBAGENT_NESTING_REFUSAL,
  SUBAGENT_STOPPED,
} from "./pi-runtime-subagent.js";
import type { RunContext } from "./run-context.js";
import { secretPausedToolResult } from "./run-secret.js";
import type * as GateModule from "./run-tool-gate.js";
import type { ToolCall } from "./run-tool-gate.js";
import type * as RequestModule from "./run-tool-request.js";
import type { ToolRequest } from "./run-tool-request.js";
import type * as IntegrationsModule from "./run-tools-integrations.js";
import {
  auditToolCall,
  contentDigest,
  mcpServerHost,
  recordRuntimeToolCall,
  toolCallApproval,
  toolCallOutcome,
} from "./tool-call-event.js";

const recordSecurityEvent = vi.hoisted(() => vi.fn(async (_event: unknown) => undefined));
const recordAuditEvent = vi.hoisted(() => vi.fn(async (_event: unknown) => undefined));
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof DbModule>()),
  recordSecurityEvent,
  recordAuditEvent,
}));

const gateToolCall = vi.hoisted(() => vi.fn());
vi.mock("./run-tool-gate.js", async (importOriginal) => ({
  ...(await importOriginal<typeof GateModule>()),
  gateToolCall,
}));

const resolveToolRequest = vi.hoisted(() => vi.fn());
const prepareToolRequest = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("./run-tool-request.js", async (importOriginal) => ({
  ...(await importOriginal<typeof RequestModule>()),
  resolveToolRequest,
  prepareToolRequest,
}));

const connectorTool = vi.hoisted(() => vi.fn());
vi.mock("./run-tools-integrations.js", async (importOriginal) => ({
  ...(await importOriginal<typeof IntegrationsModule>()),
  connectorTool,
}));

const { applyTool } = await import("./run-tools.js");

const SERVER_ROUTE = { connectorId: "mcp", resourceId: "server-1", toolName: "list_issues" };
const MCP_TOOL: ConnectorTool = {
  name: "mcp__tracker__list_issues",
  description: "List issues",
  inputSchema: { type: "object" },
  readOnly: true,
  route: SERVER_ROUTE,
};

function fakeContext({
  tools = [MCP_TOOL],
  server = {
    transport: "http",
    endpoint: "https://mcp.tracker.example/mcp",
    command: null,
    args: [],
  } as {
    transport: string;
    endpoint: string | null;
    command: string | null;
    args: unknown;
  } | null,
} = {}) {
  const abortController = new AbortController();
  const findFirst = vi.fn(async () => server);
  const ctx = {
    run: { userId: "user-1", spaceId: "space-1", threadId: "thread-1", botId: "bot-1" },
    runId: "run-1",
    bot: { id: "bot-1", name: "Bot" },
    thread: { id: "thread-1" },
    deps: { prisma: { mcpServer: { findFirst } } },
    tools: {
      connector: new Map(tools.map((tool) => [tool.name, tool])),
      disabled: new Set<string>(),
      builtins: [{ name: "cloud_agent_launch", description: "", inputSchema: {} }],
    },
    computer: { pageBrowserAllowed: true, acceptsImages: true },
    context: { signal: abortController.signal },
    abortController,
    state: { tainted: false, handedOff: false, approval: { pausePending: false } },
  } as unknown as RunContext;
  return { ctx, abortController, findFirst };
}

function request(name: string, args: Record<string, unknown>, route = SERVER_ROUTE) {
  return {
    name,
    args,
    executionId: "call-1",
    connectorCall: { tool: name, args, executionId: "call-1", route },
    effectRequest: args,
    resolvedTool: undefined,
    catalogRemapped: false,
    nextApprovedTool: undefined,
    approvedEffectKey: undefined,
    replayEffectToolName: name,
    fleetSummary: undefined,
    heldForApproval: false,
    purchase: undefined,
    cardUse: undefined,
  } satisfies ToolRequest;
}

function passedCall(
  name: string,
  args: Record<string, unknown>,
  approval: { status?: string; bypass?: boolean } = {},
): ToolCall {
  return {
    name,
    args,
    executionId: "call-1",
    observer: undefined,
    connectorCall: { tool: name, args, executionId: "call-1", route: SERVER_ROUTE },
    effectKey: "key",
    applied: approval.status
      ? ({ duplicate: true, effect: { id: "effect-9", status: approval.status } } as never)
      : undefined,
    nextApprovedTool: undefined,
    bypassApproval: approval.bypass ?? false,
    claimedEffect: false,
    spend: undefined,
    persistEffectResult: async () => true,
    finish: async (result) => result,
    claimOrReturn: async () => undefined,
  };
}

type RecordedEvent = {
  type: string;
  userId: string;
  spaceId: string;
  metadata: Record<string, unknown>;
};

function recordedEvents(): RecordedEvent[] {
  return recordSecurityEvent.mock.calls.map(([event]) => event as RecordedEvent);
}

beforeEach(() => {
  recordSecurityEvent.mockReset();
  recordSecurityEvent.mockImplementation(async () => undefined);
  gateToolCall.mockReset();
  resolveToolRequest.mockReset();
  prepareToolRequest.mockReset();
  prepareToolRequest.mockImplementation(async () => undefined);
  connectorTool.mockReset();
});

describe("tool.called through the dispatcher", () => {
  it("records a call that ran, with its host, sizes and hash but none of its content", async () => {
    const { ctx } = fakeContext();
    const args = { query: "acme confidential roadmap" };
    resolveToolRequest.mockResolvedValue(request(MCP_TOOL.name, args));
    gateToolCall.mockImplementation(async () => ({ call: passedCall(MCP_TOOL.name, args) }));
    connectorTool.mockResolvedValue({ issues: ["secret plans"] });

    await expect(applyTool(ctx, MCP_TOOL.name, args, "call-1")).resolves.toEqual({
      issues: ["secret plans"],
    });

    const [event] = recordedEvents();
    expect(recordedEvents()).toHaveLength(1);
    expect(event).toMatchObject({
      type: "tool.called",
      userId: "user-1",
      spaceId: "space-1",
      metadata: {
        tool: MCP_TOOL.name,
        connector: "mcp",
        remoteTool: "list_issues",
        resourceId: "server-1",
        host: "mcp.tracker.example",
        argsSha256: contentDigest(args).sha256,
        argsBytes: contentDigest(args).bytes,
        resultBytes: contentDigest({ issues: ["secret plans"] }).bytes,
        outcome: "ok",
        approval: "none",
        runId: "run-1",
        threadId: "thread-1",
        botId: "bot-1",
      },
    });
    expect(event!.metadata.durationMs).toBeTypeOf("number");
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("acme confidential roadmap");
    expect(serialized).not.toContain("secret plans");
  });

  it("records a call its gate refused as refused, without running it", async () => {
    const { ctx } = fakeContext();
    resolveToolRequest.mockResolvedValue(request(MCP_TOOL.name, {}));
    gateToolCall.mockResolvedValue({ result: { error: "blocked in this space" } });

    await applyTool(ctx, MCP_TOOL.name, {}, "call-1");

    expect(connectorTool).not.toHaveBeenCalled();
    expect(recordedEvents().map((event) => event.metadata.outcome)).toEqual(["refused"]);
    expect(recordedEvents()[0]!.metadata.resultBytes).toBeUndefined();
  });

  it("records a call refused before its gate", async () => {
    const { ctx } = fakeContext();
    ctx.tools.disabled.add(MCP_TOOL.name);

    await expect(applyTool(ctx, MCP_TOOL.name, {}, "call-1")).resolves.toEqual({
      error: "This tool is disabled for this bot.",
    });

    expect(gateToolCall).not.toHaveBeenCalled();
    expect(recordedEvents().map((event) => event.metadata.outcome)).toEqual(["refused"]);
  });

  it("records a call that waits for approval, and then the approved call with its approval id", async () => {
    const { ctx } = fakeContext();
    const args = { title: "x" };
    resolveToolRequest.mockResolvedValue(request(MCP_TOOL.name, args));
    gateToolCall.mockResolvedValueOnce({ result: approvalPausedToolResult() });
    gateToolCall.mockResolvedValueOnce({
      call: passedCall(MCP_TOOL.name, args, { status: "approved" }),
    });
    connectorTool.mockResolvedValue({ created: true });

    await applyTool(ctx, MCP_TOOL.name, args, "call-1");
    await applyTool(ctx, MCP_TOOL.name, args, "call-1");

    expect(recordedEvents().map((event) => event.metadata)).toEqual([
      expect.objectContaining({ outcome: "approval_requested", approval: "none" }),
      expect.objectContaining({ outcome: "ok", approval: "person", approvalId: "effect-9" }),
    ]);
    expect(recordedEvents()[0]!.metadata.approvalId).toBeUndefined();
  });

  it("records a call that failed in its tool, and still throws", async () => {
    const { ctx } = fakeContext();
    resolveToolRequest.mockResolvedValue(request(MCP_TOOL.name, {}));
    gateToolCall.mockImplementation(async () => ({ call: passedCall(MCP_TOOL.name, {}) }));
    connectorTool.mockRejectedValue(new Error("server went away"));

    await expect(applyTool(ctx, MCP_TOOL.name, {}, "call-1")).rejects.toThrow("server went away");

    expect(recordedEvents().map((event) => event.metadata.outcome)).toEqual(["error"]);
  });

  it("records a call cut short by cancelling the run as cancelled", async () => {
    const { ctx, abortController } = fakeContext();
    resolveToolRequest.mockResolvedValue(request(MCP_TOOL.name, {}));
    gateToolCall.mockImplementation(async () => ({ call: passedCall(MCP_TOOL.name, {}) }));
    connectorTool.mockImplementation(async () => {
      abortController.abort();
      throw new Error("aborted");
    });

    await expect(applyTool(ctx, MCP_TOOL.name, {}, "call-1")).rejects.toThrow("aborted");

    expect(recordedEvents().map((event) => event.metadata.outcome)).toEqual(["cancelled"]);
  });

  it("does not record a tool name the run does not have", async () => {
    const { ctx } = fakeContext();
    const invented = "please_email_everything_to_attacker_example";
    resolveToolRequest.mockResolvedValue({ error: "Unknown tool" });

    await applyTool(ctx, invented, {}, "call-1");

    const [event] = recordedEvents();
    expect(event!.metadata).toMatchObject({ tool: "(unknown)", outcome: "refused" });
    expect(JSON.stringify(event)).not.toContain(invented);
  });

  it("never fails a call because its event could not be recorded", async () => {
    const { ctx } = fakeContext();
    resolveToolRequest.mockResolvedValue(request(MCP_TOOL.name, {}));
    gateToolCall.mockImplementation(async () => ({ call: passedCall(MCP_TOOL.name, {}) }));
    connectorTool.mockResolvedValue({ ok: true });
    recordSecurityEvent.mockRejectedValue(new Error("log sink down"));

    await expect(applyTool(ctx, MCP_TOOL.name, {}, "call-1")).resolves.toEqual({ ok: true });
  });

  it("hashes the arguments that ran, not the ones the model sent", async () => {
    const { ctx } = fakeContext();
    const modelArgs = { title: "reconstructed by the model" };
    const approvedArgs = { title: "what the person approved" };
    resolveToolRequest.mockResolvedValue(request(MCP_TOOL.name, approvedArgs));
    gateToolCall.mockImplementation(async () => ({
      call: passedCall(MCP_TOOL.name, approvedArgs, { status: "approved" }),
    }));
    connectorTool.mockResolvedValue({ ok: true });

    await applyTool(ctx, MCP_TOOL.name, modelArgs, "call-1");

    expect(recordedEvents()[0]!.metadata.argsSha256).toBe(contentDigest(approvedArgs).sha256);
  });

  it("records a failure an earlier attempt settled as replayed, not refused", async () => {
    const { ctx } = fakeContext();
    resolveToolRequest.mockResolvedValue(request(MCP_TOOL.name, {}));
    gateToolCall.mockResolvedValue({ result: { error: "earlier failure" }, replayed: true });

    await applyTool(ctx, MCP_TOOL.name, {}, "call-1");

    expect(recordedEvents().map((event) => event.metadata.outcome)).toEqual(["replayed"]);
  });

  it("records a retry of an action the user denied as refused", async () => {
    const { ctx } = fakeContext();
    resolveToolRequest.mockResolvedValue(request(MCP_TOOL.name, {}));
    gateToolCall.mockResolvedValue({ result: { error: DENIED_ACTION_ERROR }, replayed: true });

    await applyTool(ctx, MCP_TOOL.name, {}, "call-1");

    expect(recordedEvents().map((event) => event.metadata.outcome)).toEqual(["refused"]);
  });

  it("records an MCP error envelope as an error", async () => {
    const { ctx } = fakeContext();
    resolveToolRequest.mockResolvedValue(request(MCP_TOOL.name, {}));
    gateToolCall.mockImplementation(async () => ({ call: passedCall(MCP_TOOL.name, {}) }));
    connectorTool.mockResolvedValue({ isError: true, content: [{ type: "text", text: "no" }] });

    await applyTool(ctx, MCP_TOOL.name, {}, "call-1");

    expect(recordedEvents().map((event) => event.metadata.outcome)).toEqual(["error"]);
  });

  it("names a declared built-in the dispatcher routes by prefix", async () => {
    const { ctx } = fakeContext();
    const builtin = request("cloud_agent_launch", {});
    builtin.connectorCall.route = undefined as never;
    resolveToolRequest.mockResolvedValue(builtin);
    gateToolCall.mockResolvedValue({ result: { error: "blocked" } });

    await applyTool(ctx, "cloud_agent_launch", {}, "call-1");

    expect(recordedEvents()[0]!.metadata.tool).toBe("cloud_agent_launch");
  });

  it("looks a server's host up once per run", async () => {
    const { ctx, findFirst } = fakeContext();
    resolveToolRequest.mockResolvedValue(request(MCP_TOOL.name, {}));
    gateToolCall.mockImplementation(async () => ({ call: passedCall(MCP_TOOL.name, {}) }));
    connectorTool.mockResolvedValue({});

    await applyTool(ctx, MCP_TOOL.name, {}, "call-1");
    await applyTool(ctx, MCP_TOOL.name, {}, "call-2");

    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "server-1", spaceId: "space-1" } }),
    );
    expect(recordedEvents().map((event) => event.metadata.host)).toEqual([
      "mcp.tracker.example",
      "mcp.tracker.example",
    ]);
  });
});

describe("auditToolCall", () => {
  it("measures duration with the given clock", async () => {
    const { ctx } = fakeContext();
    const times = [1_000, 1_250];
    await auditToolCall(
      ctx,
      MCP_TOOL.name,
      {},
      true,
      async () => ({}),
      () => times.shift()!,
    );
    expect(recordedEvents()[0]!.metadata.durationMs).toBe(250);
  });
});

describe("toolCallOutcome", () => {
  it.each([
    [{ ok: true }, true, false, "ok"],
    [{ error: "boom" }, true, false, "error"],
    [{ isError: true, content: [] }, true, false, "error"],
    [{ error: "blocked" }, false, false, "refused"],
    [{ error: "earlier failure" }, false, true, "replayed"],
    [{ stored: "earlier result" }, false, false, "replayed"],
    [approvalPausedToolResult(), false, false, "approval_requested"],
    [secretPausedToolResult(), true, false, "input_requested"],
    ["plain text", true, false, "ok"],
    [["list"], true, false, "ok"],
  ])(
    "classifies %j (past gate: %s, replayed: %s) as %s",
    (result, ranPastGate, replayed, outcome) => {
      expect(toolCallOutcome(result, { ranPastGate, replayed })).toBe(outcome);
    },
  );
});

describe("toolCallApproval", () => {
  it("names the effect a person approved", () => {
    expect(toolCallApproval(passedCall("t", {}, { status: "approved" }))).toEqual({
      approval: "person",
      approvalId: "effect-9",
    });
  });

  it("separates a policy bypass from a call that needed nothing", () => {
    expect(toolCallApproval(passedCall("t", {}, { bypass: true }))).toEqual({
      approval: "policy",
      approvalId: undefined,
    });
    expect(toolCallApproval(passedCall("t", {}))).toEqual({
      approval: "none",
      approvalId: undefined,
    });
    expect(toolCallApproval(undefined)).toEqual({ approval: "none", approvalId: undefined });
  });

  it("does not credit a person for an effect that was only recorded", () => {
    expect(toolCallApproval(passedCall("t", {}, { status: "intended" })).approval).toBe("none");
  });
});

describe("contentDigest", () => {
  it("hashes canonical JSON, so key order does not change it", () => {
    expect(contentDigest({ a: 1, b: [1, 2] })).toEqual(contentDigest({ b: [1, 2], a: 1 }));
    expect(contentDigest({ a: 1 }).sha256).not.toBe(contentDigest({ a: 2 }).sha256);
  });

  it("counts UTF-8 bytes", () => {
    expect(contentDigest("é").bytes).toBe(4);
  });

  it("still hashes values that are not plain JSON", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(contentDigest(cyclic).sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(contentDigest(undefined)).toEqual(contentDigest(null));
  });
});

describe("recordRuntimeToolCall", () => {
  it("records a tool the runtime ran itself, with its arguments' digest", async () => {
    const { ctx } = fakeContext();
    const args = { question: "Which?", options: ["a", "b"] };

    await recordRuntimeToolCall(ctx, {
      name: "ask_user",
      executionId: "call-1",
      durationMs: 5,
      args,
      result: { content: [], details: args, terminate: true },
      paused: true,
    });
    await recordRuntimeToolCall(ctx, {
      name: "run_subagent",
      executionId: "call-2",
      durationMs: 9,
      args: { task: "x" },
      error: new Error("helper failed"),
    });

    expect(recordedEvents().map((event) => event.metadata)).toEqual([
      expect.objectContaining({
        tool: "ask_user",
        outcome: "input_requested",
        argsSha256: contentDigest(args).sha256,
        durationMs: 5,
      }),
      expect.objectContaining({ tool: "run_subagent", outcome: "error" }),
    ]);
    expect(JSON.stringify(recordedEvents())).not.toContain("Which?");
  });

  it.each([
    [`${SUBAGENT_FAILURE_PREFIX}provider failed`, "error"],
    [SUBAGENT_NESTING_REFUSAL, "refused"],
    [SUBAGENT_STOPPED, "cancelled"],
    ["Result from your helper", "ok"],
  ])("records a subagent that returned %j as %s", async (text, outcome) => {
    const { ctx } = fakeContext();
    await recordRuntimeToolCall(ctx, {
      name: "run_subagent",
      executionId: "call-1",
      durationMs: 1,
      args: {},
      result: { content: [{ type: "text", text }], details: { result: text } },
    });
    expect(recordedEvents()[0]!.metadata.outcome).toBe(outcome);
  });

  it("ignores tools the dispatcher already records", async () => {
    const { ctx } = fakeContext();
    await recordRuntimeToolCall(ctx, { name: "web_fetch", executionId: "c", durationMs: 1 });
    await recordRuntimeToolCall(ctx, { name: "request_secret", executionId: "c", durationMs: 1 });
    expect(recordedEvents()).toEqual([]);
  });
});

describe("mcpServerHost", () => {
  it("names a remote server by its endpoint's hostname only", () => {
    expect(
      mcpServerHost({
        transport: "http",
        endpoint: "https://User:pw@MCP.Example.com:8443/path?q=abc",
        command: null,
        args: [],
      }),
    ).toBe("mcp.example.com");
  });

  it("names a local server by its command and package", () => {
    expect(
      mcpServerHost({
        transport: "stdio",
        endpoint: null,
        command: "/usr/local/bin/npx",
        args: ["-y", "@vendor/mcp-server@1.2.3", "--flag", "opaque-value"],
      }),
    ).toBe("stdio:npx @vendor/mcp-server@1.2.3");
  });

  it("never names an option value as the package", () => {
    for (const command of ["npx", "node", "mytool"]) {
      expect(
        mcpServerHost({
          transport: "stdio",
          endpoint: null,
          command,
          args: ["--password", "exampleSensitiveValue123", "@vendor/mcp-server"],
        }),
      ).toBe(`stdio:${command}`);
    }
  });

  it("names no package for a command that is not a known launcher", () => {
    expect(
      mcpServerHost({
        transport: "stdio",
        endpoint: null,
        command: "node",
        args: ["exampleSensitiveValue123"],
      }),
    ).toBe("stdio:node");
  });

  it("leaves out a first argument that does not read as a package name", () => {
    expect(
      mcpServerHost({
        transport: "stdio",
        endpoint: null,
        command: "uvx",
        args: ["opaque:value"],
      }),
    ).toBe("stdio:uvx");
  });

  it("has no host for a malformed endpoint", () => {
    expect(
      mcpServerHost({ transport: "http", endpoint: "not a url", command: null, args: [] }),
    ).toBeUndefined();
  });
});
