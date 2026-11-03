import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AdapterContext,
  CommandRequest,
  ComputerRef,
  PortableFile,
  ProcessEvent,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { CloudAgentRequestRejected } from "@rakazo/adapter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ComputerCloudAgentProvider,
  computerCloudAgentConfigFromEnv,
  numstatHasBinary,
  repositorySlug,
  runScript,
} from "./computer-cloud-agent.js";
import { mcpForgeTokenResolver } from "./computer-cloud-agent-forge.js";

const FORGE_TOKEN = "gho_user_secret_token";
const SHA = "a".repeat(40);
const ENV = {
  CLOUD_AGENT_COMPUTER_COMMAND: JSON.stringify(["claude", "-p"]),
  CLOUD_AGENT_COMPUTER_ENV: JSON.stringify({
    CLAUDE_CODE_USE_BEDROCK: "1",
    ANTHROPIC_BEDROCK_BASE_URL: "{{relay_url}}",
    AWS_BEARER_TOKEN_BEDROCK: "{{capability}}",
  }),
  CLOUD_AGENT_COMPUTER_REPOS: "Example/Repo",
  CLOUD_AGENT_COMPUTER_RELAY_URL: "http://model-relay:8790",
  CLOUD_AGENT_COMPUTER_MODEL: "us.anthropic.example-v1:0",
  MODEL_RELAY_SIGNING_KEY: "k".repeat(32),
};

const context: AdapterContext = {
  operationId: "op",
  traceId: "trace",
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  signal: new AbortController().signal,
};

class FakeSandbox {
  files = new Map<string, Uint8Array>();
  commands: CommandRequest[] = [];
  provisioned: Array<Record<string, unknown>> = [];
  destroyed: string[] = [];
  isolated = true;
  probeOutput = "";
  calls: unknown[] = [];

  describe() {
    return {
      id: "fake",
      contractVersion: "1",
      adapterVersion: "0",
      capabilities: {
        graphical: false,
        pty: false,
        snapshots: false,
        takeover: false,
        persistentHome: false,
        isolatedEgress: this.isolated,
      },
    };
  }
  async provision(request: Record<string, unknown>, ctx: AdapterContext): Promise<ComputerRef> {
    this.calls.push({ provision: request, ctx: ctx.botId });
    this.provisioned.push(request);
    return { id: "computer-1", botId: String(request.botId), kind: "docker", providerRef: "c1" };
  }
  async prepare() {}
  async *execute(_c: ComputerRef, request: CommandRequest): AsyncIterable<ProcessEvent> {
    this.calls.push({ execute: request });
    this.commands.push(request);
    if (request.argv[0] === "bash" && request.argv[1] === "-c") {
      const size = /^wc -c < (.+)$/.exec(request.argv[2] ?? "");
      if (size) {
        const file = this.files.get(size[1]!);
        if (!file) {
          yield { type: "exit", code: 1 };
          return;
        }
        yield { type: "stdout", data: `${file.byteLength}\n` };
      } else {
        yield { type: "stdout", data: this.probeOutput };
      }
    }
    yield { type: "exit", code: 0 };
  }
  async writeFile(_c: ComputerRef, file: PortableFile) {
    this.calls.push({ writeFile: file.path, bytes: file.content.byteLength });
    this.files.set(file.path, file.content);
  }
  async readFile(
    _c: ComputerRef,
    file: string,
    _ctx: AdapterContext,
    options?: { maxBytes?: number },
  ) {
    const content = this.files.get(file);
    if (!content) throw new Error("missing");
    if (options?.maxBytes !== undefined && content.byteLength > options.maxBytes) {
      throw new Error("too large");
    }
    return content;
  }
  async destroy(c: ComputerRef) {
    this.destroyed.push(c.id);
  }
  put(file: string, text: string) {
    this.files.set(`.rakazo-coding/${file}`, new TextEncoder().encode(text));
  }
}

function forgeFetch(log: Array<{ url: string; init?: RequestInit }>) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    log.push({ url, init });
    if (url.endsWith("/capabilities/revoke")) return new Response(null, { status: 204 });
    if (url === "https://api.github.com/repos/example/repo") {
      return Response.json({ default_branch: "main" });
    }
    if (url === "https://api.github.com/repos/example/repo/commits/main") {
      return Response.json({ sha: SHA });
    }
    if (url === `https://api.github.com/repos/example/repo/tarball/${SHA}`) {
      return new Response(new Uint8Array(5 * 1024 * 1024).fill(7));
    }
    return new Response("nope", { status: 404 });
  });
}

describe("computer cloud agent configuration", () => {
  it("parses the settings and refuses malformed ones", () => {
    const config = computerCloudAgentConfigFromEnv(ENV);
    expect(config).toMatchObject({
      command: ["claude", "-p"],
      repositories: ["example/repo"],
      relayUrl: "http://model-relay:8790",
      deadlineMs: 3_600_000,
    });
    for (const [key, value, message] of [
      ["CLOUD_AGENT_COMPUTER_COMMAND", "[]", "COMMAND"],
      ["CLOUD_AGENT_COMPUTER_COMMAND", "claude", "JSON"],
      ["CLOUD_AGENT_COMPUTER_ENV", '{"lower":"x"}', "CLOUD_AGENT_COMPUTER_ENV"],
      ["CLOUD_AGENT_COMPUTER_REPOS", "", "REPOS"],
      ["CLOUD_AGENT_COMPUTER_REPOS", "no-slash", "invalid repository"],
      ["CLOUD_AGENT_COMPUTER_RELAY_URL", "http://u@relay/x", "RELAY_URL"],
      ["MODEL_RELAY_SIGNING_KEY", "short", "MODEL_RELAY_SIGNING_KEY"],
      ["CLOUD_AGENT_COMPUTER_MODEL", "", "MODEL"],
      ["CLOUD_AGENT_COMPUTER_DEADLINE_MS", "-1", "DEADLINE"],
      ["CLOUD_AGENT_COMPUTER_FORGE_API", "http://api.example", "https"],
    ] as const) {
      expect(() => computerCloudAgentConfigFromEnv({ ...ENV, [key]: value }), key).toThrow(message);
    }
  });

  it("reads repository URLs and binary numstat lines", () => {
    expect(repositorySlug("https://github.com/Example/Repo")).toBe("example/repo");
    expect(repositorySlug("https://github.com/example/repo.git")).toBe("example/repo");
    expect(repositorySlug("https://github.com/example/repo/")).toBe("example/repo");
    for (const url of ["http://github.com/a/b", "https://gitlab.com/a/b", "https://github.com/a"]) {
      expect(repositorySlug(url)).toBeUndefined();
    }
    expect(numstatHasBinary("1\t2\ta.ts\n-\t-\timage.png\n")).toBe(true);
    expect(numstatHasBinary("1\t2\ta.ts\n")).toBe(false);
  });

  it("records the diff against the imported baseline, whatever the command commits", () => {
    const script = runScript();
    expect(script).toContain("base=$(git rev-parse HEAD)");
    expect(script).toContain('g diff --cached --binary "$base"');
    expect(script).toContain('g diff --cached --numstat "$base"');
    expect(script).not.toMatch(/diff --cached [^\n]*HEAD/);
    expect(script).toContain('"$@" "$(cat "$work/brief.md")"');
    expect(script.indexOf("diff.patch")).toBeGreaterThan(script.indexOf("code=$?"));
    expect(script.indexOf('echo "$code" > "$work/exit"')).toBeGreaterThan(
      script.indexOf("diff.patch"),
    );
  });
});

describe("computer cloud agent provider", () => {
  let dataDir: string;
  let sandbox: FakeSandbox;
  let log: Array<{ url: string; init?: RequestInit }>;
  let now: number;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "computer-agent-"));
    sandbox = new FakeSandbox();
    log = [];
    now = 1_000_000;
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  function provider(token: string | null = FORGE_TOKEN) {
    return new ComputerCloudAgentProvider(computerCloudAgentConfigFromEnv(ENV), {
      sandbox: sandbox as unknown as SandboxProvider,
      dataDir,
      forgeToken: async () => token ?? undefined,
      fetch: forgeFetch(log) as unknown as typeof fetch,
      now: () => now,
    });
  }

  const launch = (
    agent: ComputerCloudAgentProvider,
    repository = "https://github.com/example/repo",
  ) =>
    agent.launch(
      { idempotencyKey: "agent-1", prompt: "Fix the bug in issue 12", repository },
      context,
    );

  it("runs in an isolated single-use computer and keeps the forge token out of it", async () => {
    const agent = provider();
    await expect(launch(agent)).resolves.toMatchObject({ id: "agent-1", status: "running" });

    expect(sandbox.provisioned).toEqual([
      {
        botId: "coding-agent-1",
        homePath: path.join(dataDir, "homes", "coding-agent-1"),
        egress: "none",
      },
    ]);
    const parts = [...sandbox.files.keys()].filter((name) => name.includes("snapshot.part-"));
    expect(parts).toHaveLength(3);
    expect(new TextDecoder().decode(sandbox.files.get(".rakazo-coding/brief.md"))).toBe(
      "Fix the bug in issue 12",
    );
    const start = sandbox.commands.at(-1)!;
    // Detached, with every inherited stream closed, so the exec returns at once.
    expect(start.argv).toEqual([
      "bash",
      "-c",
      'setsid -f bash "$0" "$@" </dev/null >/dev/null 2>&1',
      ".rakazo-coding/run.sh",
      "claude",
      "-p",
    ]);
    expect(start.env).toMatchObject({
      CLAUDE_CODE_USE_BEDROCK: "1",
      ANTHROPIC_BEDROCK_BASE_URL: "http://model-relay:8790",
      RAKAZO_CODING_TIMEOUT_S: "3600",
    });
    expect(start.env?.AWS_BEARER_TOKEN_BEDROCK).toMatch(/^rkc1\./);

    // The forge token is only ever sent to the forge.
    expect(JSON.stringify(sandbox.calls)).not.toContain(FORGE_TOKEN);
    for (const file of sandbox.files.values()) {
      expect(Buffer.from(file).includes(Buffer.from(FORGE_TOKEN))).toBe(false);
    }
    const authorized = log.filter((entry) =>
      new Headers(entry.init?.headers).get("authorization")?.includes(FORGE_TOKEN),
    );
    expect(authorized.every((entry) => entry.url.startsWith("https://api.github.com/"))).toBe(true);

    // A replayed launch is idempotent.
    await launch(agent);
    expect(sandbox.provisioned).toHaveLength(1);
  });

  it("refuses repositories off the allowlist, a missing token and a sandbox that can't isolate", async () => {
    await expect(launch(provider(), "https://github.com/other/repo")).rejects.toBeInstanceOf(
      CloudAgentRequestRejected,
    );
    await expect(launch(provider(null))).rejects.toBeInstanceOf(CloudAgentRequestRejected);
    sandbox.isolated = false;
    await expect(launch(provider())).rejects.toThrow(/isolate/);
    expect(sandbox.provisioned).toHaveLength(0);
  });

  it("tears the computer down when the isolation probe finds a route", async () => {
    sandbox.probeOutput = "ROUTE\n";
    await expect(launch(provider())).rejects.toBeInstanceOf(CloudAgentRequestRejected);
    expect(sandbox.destroyed).toEqual(["computer-1"]);
    expect(sandbox.commands.some((c) => c.argv.includes(".rakazo-coding/run.sh"))).toBe(false);
  });

  it("stays running until the command exits, then keeps the diff and destroys the computer", async () => {
    const agent = provider();
    await launch(agent);
    await expect(agent.get("agent-1", context)).resolves.toMatchObject({ status: "running" });

    sandbox.put("exit", "0\n");
    sandbox.put("numstat.txt", "1\t0\tsrc/a.ts\n");
    sandbox.put("diff.patch", "diff --git a/src/a.ts b/src/a.ts\n+fixed\n");
    sandbox.put("output.txt", "Fixed the off-by-one.");
    await expect(agent.get("agent-1", context)).resolves.toMatchObject({ status: "finished" });
    expect(sandbox.destroyed).toEqual(["computer-1"]);
    expect(log.some((entry) => entry.url === "http://model-relay:8790/capabilities/revoke")).toBe(
      true,
    );
    await expect(stat(path.join(dataDir, "homes", "coding-agent-1"))).rejects.toThrow();

    await expect(agent.result("agent-1")).resolves.toMatchObject({
      status: "finished",
      repository: "example/repo",
      baseSha: SHA,
      summary: "Fixed the off-by-one.",
      diff: expect.stringContaining("+fixed"),
      diffTruncated: false,
    });
    const state = JSON.parse(
      await readFile(path.join(dataDir, "cloud-agents", "agent-1", "state.json"), "utf8"),
    );
    expect(state.capability).toBeUndefined();
  });

  it("fails a run whose diff is binary or too large", async () => {
    for (const [numstat, diff, reason] of [
      ["-\t-\tlogo.png\n", "binary", "binary"],
      ["1\t0\ta\n", "x".repeat(1024 * 1024 + 10), "exceeds the size limit"],
    ] as const) {
      sandbox = new FakeSandbox();
      const agent = provider();
      await rm(path.join(dataDir, "cloud-agents"), { recursive: true, force: true });
      await launch(agent);
      sandbox.put("exit", "0");
      sandbox.put("numstat.txt", numstat);
      if (diff) sandbox.put("diff.patch", diff);
      await expect(agent.get("agent-1", context)).resolves.toMatchObject({ status: "failed" });
      await expect(agent.result("agent-1")).resolves.toMatchObject({
        reason: expect.stringContaining(reason),
      });
    }
  });

  it("fails a run past its deadline, and cancels on request", async () => {
    const agent = provider();
    await launch(agent);
    now += 3_600_000 + 61_000;
    await expect(agent.get("agent-1", context)).resolves.toMatchObject({ status: "failed" });
    expect(sandbox.destroyed).toEqual(["computer-1"]);

    await rm(path.join(dataDir, "cloud-agents"), { recursive: true, force: true });
    sandbox = new FakeSandbox();
    now = 1_000_000;
    const second = provider();
    await launch(second);
    await expect(second.cancel("agent-1", context)).resolves.toMatchObject({ status: "cancelled" });
    expect(sandbox.destroyed).toEqual(["computer-1"]);
  });

  it("refuses image attachments instead of ignoring them", async () => {
    await expect(
      provider().launch(
        {
          idempotencyKey: "agent-1",
          prompt: "Fix it",
          repository: "https://github.com/example/repo",
          images: [{ data: "aGk=", mimeType: "image/png" }],
        },
        context,
      ),
    ).rejects.toBeInstanceOf(CloudAgentRequestRejected);
    expect(sandbox.provisioned).toHaveLength(0);
  });

  it("refuses a snapshot over the limit while reading it, with no length declared", async () => {
    const config = { ...computerCloudAgentConfigFromEnv(ENV), maxSnapshotBytes: 1024 };
    const agent = new ComputerCloudAgentProvider(config, {
      sandbox: sandbox as unknown as SandboxProvider,
      dataDir,
      forgeToken: async () => FORGE_TOKEN,
      fetch: forgeFetch(log) as unknown as typeof fetch,
      now: () => now,
    });
    await expect(launch(agent)).rejects.toBeInstanceOf(CloudAgentRequestRejected);
    expect(sandbox.provisioned).toHaveLength(0);
  });

  it("retries an unreadable result instead of reporting an empty diff", async () => {
    const agent = provider();
    await launch(agent);
    sandbox.put("exit", "0");
    // Neither numstat nor the diff can be read: still running, computer kept.
    await expect(agent.get("agent-1", context)).resolves.toMatchObject({ status: "running" });
    expect(sandbox.destroyed).toEqual([]);
    sandbox.put("numstat.txt", "1\t0\ta.ts\n");
    sandbox.put("diff.patch", "+fixed\n");
    await expect(agent.get("agent-1", context)).resolves.toMatchObject({ status: "finished" });
    await expect(agent.result("agent-1")).resolves.toMatchObject({ diff: "+fixed\n" });
  });

  it("keeps the run open until its computer is really gone", async () => {
    const agent = provider();
    await launch(agent);
    const destroy = vi
      .spyOn(sandbox, "destroy")
      .mockRejectedValueOnce(new Error("supervisor down"));
    await expect(agent.cancel("agent-1", context)).resolves.toMatchObject({ status: "running" });
    // The retry has its own signal, so an aborted poll context can't fail it.
    const aborted = { ...context, signal: AbortSignal.abort() };
    await expect(agent.get("agent-1", aborted)).resolves.toMatchObject({ status: "cancelled" });
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(
      (destroy.mock.calls[1] as unknown as [ComputerRef, AdapterContext])[1].signal.aborted,
    ).toBe(false);
  });

  it("recovers a lost computer reference by its bot id before giving up the run", async () => {
    const agent = provider();
    await launch(agent);
    const statePath = path.join(dataDir, "cloud-agents", "agent-1", "state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    delete state.computer;
    delete state.runStarted;
    await writeFile(statePath, JSON.stringify(state));
    await expect(agent.get("agent-1", context)).resolves.toMatchObject({ status: "failed" });
    expect(sandbox.provisioned.at(-1)).toMatchObject({ botId: "coding-agent-1", egress: "none" });
    expect(sandbox.destroyed).toEqual(["computer-1"]);
  });

  it("only reads results in a process without the runtime", async () => {
    const reader = new ComputerCloudAgentProvider(null, { dataDir });
    await expect(reader.result("agent-1")).resolves.toBeUndefined();
    await expect(launch(reader)).rejects.toThrow(/worker only/);
    await expect(reader.get("../escape", context)).rejects.toBeInstanceOf(
      CloudAgentRequestRejected,
    );
  });
});

describe("forge token resolver", () => {
  it("uses the token of the user's connection to the forge's authorization server", async () => {
    const findMany = vi.fn(async () => [
      { id: "linear", endpoint: "https://mcp.linear.app/mcp", secretId: "s1" },
      { id: "github", endpoint: "https://api.example.test/mcp", secretId: "s2" },
    ]);
    const providerFor = vi.fn(async (server: { id: string }) => ({
      discoveryState: () => ({
        authorizationServerUrl:
          server.id === "github" ? "https://github.com/login/oauth/" : "https://linear.app",
      }),
      tokens: async () => ({ access_token: `${server.id}-token`, token_type: "bearer" }),
    }));
    const resolve = mcpForgeTokenResolver({
      prisma: { mcpServer: { findMany } } as never,
      broker: { providerFor } as never,
      issuer: "https://github.com/login/oauth",
    });
    await expect(resolve("user-1", "space-1")).resolves.toBe("github-token");
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: "user-1", spaceId: "space-1" }),
      }),
    );
  });

  it("returns undefined when the user has no forge connection", async () => {
    const resolve = mcpForgeTokenResolver({
      prisma: { mcpServer: { findMany: async () => [] } } as never,
      broker: { providerFor: async () => undefined } as never,
      issuer: "https://github.com/login/oauth",
    });
    await expect(resolve("user-1", "space-1")).resolves.toBeUndefined();
  });
});
