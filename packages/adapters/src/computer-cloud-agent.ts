import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AdapterContext,
  CloudAgentHandle,
  CloudAgentLaunchRequest,
  CloudAgentProvider,
  CloudAgentReplyRequest,
  CloudAgentSnapshot,
  CloudAgentStatus,
  ComputerRef,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { CloudAgentRequestRejected, CloudAgentRetryLater } from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import { issueRelayCapability } from "./model-relay-capability.js";
import { readBodyCapped } from "./web-ssrf.js";

/**
 * Fork patch: the `computer` cloud-agent provider (docs/fork-computer-coding-agent.md).
 *
 * Each run gets a single-use computer with isolated egress (no route off the
 * host, docs/fork-isolated-computer-egress.md). The worker fetches the
 * repository snapshot with the run owner's own forge token, which never enters
 * the computer, imports it, and starts a configured headless coding command.
 * The command reaches a model only through the relay
 * (docs/fork-computer-model-relay.md), with a per-run capability. When it
 * finishes, the worker keeps the diff and summary on the host, destroys the
 * computer and revokes the capability. Nothing is pushed: publishing is a
 * separate, explicitly approved step.
 */

export interface ComputerCloudAgentConfig {
  /** argv of the headless coding command. The brief is appended as the last argument. */
  command: string[];
  /** Extra environment for the command. `{{relay_url}}` and `{{capability}}` are filled in. */
  env: Record<string, string>;
  /** Allowed repositories, `owner/name`, lower case. */
  repositories: string[];
  relayUrl: string;
  relayKey: string;
  model: string;
  deadlineMs: number;
  maxRequests: number;
  forgeApi: string;
  maxDiffBytes: number;
  maxSnapshotBytes: number;
}

export interface ComputerCloudAgentDeps {
  sandbox?: SandboxProvider;
  dataDir: string;
  /** The run owner's own forge token, or undefined when they have not connected one. */
  forgeToken?: (userId: string, spaceId: string) => Promise<string | undefined>;
  fetch?: typeof fetch;
  now?: () => number;
}

type Phase = "running" | "finished" | "failed" | "cancelled";

interface RunState {
  id: string;
  userId: string;
  spaceId: string;
  repository: string;
  baseSha: string;
  botId: string;
  computer?: ComputerRef;
  capability?: string;
  /** Set once the coding command has been started in the computer. */
  runStarted?: boolean;
  /** A teardown that has not finished yet: the run turns terminal once the computer is gone. */
  pending?: { status: Phase; reason?: string };
  startedAt: number;
  deadline: number;
  status: Phase;
  reason?: string;
}

export interface ComputerCloudAgentResult {
  status: Phase;
  repository: string;
  baseSha: string;
  summary: string;
  diff: string;
  diffBytes: number;
  diffTruncated: boolean;
  reason?: string;
}

const WORK_DIR = ".rakazo-coding";
const CHUNK_BYTES = 2 * 1024 * 1024;
const RESULT_DIFF_PREVIEW_BYTES = 60_000;
/** How long a result that can't be read, or a computer that won't go, is retried past the deadline. */
const RETRY_GRACE_MS = 60 * 60_000;
const CLEANUP_TIMEOUT_MS = 60_000;
const SUMMARY_BYTES = 16_000;
const DEFAULTS = {
  deadlineMs: 60 * 60_000,
  maxRequests: 1000,
  forgeApi: "https://api.github.com",
  maxDiffBytes: 1024 * 1024,
  maxSnapshotBytes: 200 * 1024 * 1024,
};

/** Reads CLOUD_AGENT_COMPUTER_* and MODEL_RELAY_SIGNING_KEY; throws on a malformed value. */
export function computerCloudAgentConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ComputerCloudAgentConfig {
  const parseJson = <T>(name: string, value: string | undefined, fallback?: T): T => {
    if (!value?.trim()) {
      if (fallback !== undefined) return fallback;
      throw new Error(`${name} is required`);
    }
    try {
      return JSON.parse(value) as T;
    } catch {
      throw new Error(`${name} must be JSON`);
    }
  };
  const command = parseJson<unknown>(
    "CLOUD_AGENT_COMPUTER_COMMAND",
    env.CLOUD_AGENT_COMPUTER_COMMAND,
  );
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    !command.every((part) => typeof part === "string" && part.length > 0)
  ) {
    throw new Error("CLOUD_AGENT_COMPUTER_COMMAND must be a non-empty JSON array of strings");
  }
  const extraEnv = parseJson<unknown>("CLOUD_AGENT_COMPUTER_ENV", env.CLOUD_AGENT_COMPUTER_ENV, {});
  if (
    !extraEnv ||
    typeof extraEnv !== "object" ||
    Array.isArray(extraEnv) ||
    !Object.entries(extraEnv).every(
      ([key, value]) => /^[A-Z_][A-Z0-9_]*$/.test(key) && typeof value === "string",
    )
  ) {
    throw new Error("CLOUD_AGENT_COMPUTER_ENV must be a JSON object of NAME: string");
  }
  const repositories = (env.CLOUD_AGENT_COMPUTER_REPOS ?? "")
    .split(",")
    .map((repo) => repo.trim().toLowerCase())
    .filter(Boolean);
  if (repositories.length === 0) throw new Error("CLOUD_AGENT_COMPUTER_REPOS is required");
  const invalidRepo = repositories.find((repo) => !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repo));
  if (invalidRepo) throw new Error(`CLOUD_AGENT_COMPUTER_REPOS: invalid repository ${invalidRepo}`);
  const relayUrl = env.CLOUD_AGENT_COMPUTER_RELAY_URL?.trim() ?? "";
  if (!/^https?:\/\/[^/@\s]+(:\d+)?\/?$/.test(relayUrl)) {
    throw new Error("CLOUD_AGENT_COMPUTER_RELAY_URL must be http(s)://host[:port]");
  }
  const relayKey = env.MODEL_RELAY_SIGNING_KEY?.trim() ?? "";
  if (relayKey.length < 32) throw new Error("MODEL_RELAY_SIGNING_KEY must be 32+ characters");
  const model = env.CLOUD_AGENT_COMPUTER_MODEL?.trim();
  if (!model) throw new Error("CLOUD_AGENT_COMPUTER_MODEL is required");
  const positive = (name: string, fallback: number) => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0)
      throw new Error(`${name} must be a positive integer`);
    return value;
  };
  const forgeApi = env.CLOUD_AGENT_COMPUTER_FORGE_API?.trim() || DEFAULTS.forgeApi;
  if (!forgeApi.startsWith("https://")) {
    throw new Error("CLOUD_AGENT_COMPUTER_FORGE_API must be https");
  }
  return {
    command: command as string[],
    env: extraEnv as Record<string, string>,
    repositories: [...new Set(repositories)],
    relayUrl: relayUrl.replace(/\/$/, ""),
    relayKey,
    model,
    deadlineMs: positive("CLOUD_AGENT_COMPUTER_DEADLINE_MS", DEFAULTS.deadlineMs),
    maxRequests: positive("CLOUD_AGENT_COMPUTER_MAX_REQUESTS", DEFAULTS.maxRequests),
    forgeApi: forgeApi.replace(/\/$/, ""),
    maxDiffBytes: positive("CLOUD_AGENT_COMPUTER_MAX_DIFF_BYTES", DEFAULTS.maxDiffBytes),
    maxSnapshotBytes: DEFAULTS.maxSnapshotBytes,
  };
}

/** `https://github.com/<owner>/<name>` (optionally `.git` or a trailing slash) → `owner/name`. */
export function repositorySlug(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(
    url.trim(),
  );
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : undefined;
}

/** The script that unpacks the snapshot, runs the command and records the diff. */
export function runScript() {
  return `#!/bin/bash
# Written by the computer cloud-agent provider. Arguments: the coding command.
set -u
work="$HOME/${WORK_DIR}"
repo="$HOME/repo"
fail() { echo "$1" > "$work/error"; echo 1 > "$work/exit"; exit 1; }
cat "$work"/snapshot.part-* > "$work/snapshot.tgz" || fail "snapshot assembly failed"
rm -f "$work"/snapshot.part-*
mkdir -p "$repo" || fail "cannot create the repository directory"
tar -xzf "$work/snapshot.tgz" --strip-components=1 -C "$repo" || fail "snapshot unpack failed"
rm -f "$work/snapshot.tgz"
cd "$repo" || fail "cannot enter the repository"
g() { git -c user.name=rakazo -c user.email=rakazo@localhost -c commit.gpgsign=false "$@"; }
g init -q && g add -A && g commit -q -m base || fail "baseline commit failed"
# The imported baseline, kept apart from HEAD: the command may commit its own work.
base=$(git rev-parse HEAD) || fail "baseline commit failed"
timeout --kill-after=30 "\${RAKAZO_CODING_TIMEOUT_S:-3600}" "$@" "$(cat "$work/brief.md")" \\
  > "$work/output.txt" 2> "$work/stderr.txt"
code=$?
cd "$repo" && g add -A && g diff --cached --binary "$base" > "$work/diff.patch" \\
  && g diff --cached --numstat "$base" > "$work/numstat.txt" || fail "diff failed"
echo "$code" > "$work/exit"
`;
}

/** Whether a `git diff --numstat` lists a binary change ("-\t-\tpath"). */
export function numstatHasBinary(numstat: string) {
  return numstat.split("\n").some((line) => line.startsWith("-\t-\t"));
}

function renderEnv(template: Record<string, string>, values: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(template).map(([key, value]) => [
      key,
      value.replace(/\{\{(relay_url|capability)\}\}/g, (_, name: string) => values[name] ?? ""),
    ]),
  );
}

export class ComputerCloudAgentProvider implements CloudAgentProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  /** `config` is null in a process that only reads results (the API). */
  constructor(
    private readonly runtimeConfig: ComputerCloudAgentConfig | null,
    private readonly deps: ComputerCloudAgentDeps,
  ) {
    this.fetchImpl = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
  }

  describe() {
    return {
      id: "computer",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { launch: true, reply: false, cancel: true, offline: false },
    };
  }

  private runDir(id: string) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new CloudAgentRequestRejected("not_found");
    return path.join(this.deps.dataDir, "cloud-agents", id);
  }

  private async loadState(id: string): Promise<RunState | undefined> {
    const raw = await readFile(path.join(this.runDir(id), "state.json"), "utf8").catch(() => "");
    return raw ? (JSON.parse(raw) as RunState) : undefined;
  }

  private async saveState(state: RunState) {
    const dir = this.runDir(state.id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(dir, "state.json.tmp"), JSON.stringify(state), { mode: 0o600 });
    await rename(path.join(dir, "state.json.tmp"), path.join(dir, "state.json"));
  }

  private snapshotOf(state: RunState): CloudAgentSnapshot {
    const status: CloudAgentStatus = state.status;
    return {
      id: state.id,
      url: `https://github.com/${state.repository}`,
      title: `Coding run on ${state.repository}`,
      status,
      latestRunId: "1",
    };
  }

  private get config(): ComputerCloudAgentConfig {
    if (!this.runtimeConfig) throw new Error("the computer cloud agent runs in the worker only");
    return this.runtimeConfig;
  }

  private requireRuntime() {
    const { sandbox, forgeToken } = this.deps;
    if (!sandbox || !forgeToken || !this.runtimeConfig) {
      throw new Error("the computer cloud agent runs in the worker only");
    }
    return { sandbox, forgeToken };
  }

  private computerContext(context: AdapterContext, botId: string): AdapterContext {
    return { ...context, botId };
  }

  private async forge(
    token: string,
    url: string,
    accept = "application/vnd.github+json",
    timeoutMs = 45_000,
  ) {
    const response = await this.fetchImpl(url, {
      headers: { accept, authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    }).catch(() => {
      throw new CloudAgentRetryLater("unavailable");
    });
    if (response.status === 401) throw new CloudAgentRequestRejected("invalid");
    if (response.status === 403 || response.status === 404) {
      throw new CloudAgentRequestRejected("invalid");
    }
    if (response.status === 429) throw new CloudAgentRetryLater("rate_limited");
    if (!response.ok) throw new CloudAgentRetryLater("unavailable");
    return response;
  }

  async launch(
    request: CloudAgentLaunchRequest,
    context: AdapterContext,
  ): Promise<CloudAgentHandle> {
    const { sandbox, forgeToken } = this.requireRuntime();
    const id = request.idempotencyKey;
    const existing = await this.loadState(id);
    if (existing) return this.snapshotOf(existing);

    const repository = repositorySlug(request.repository);
    if (!repository || !this.config.repositories.includes(repository)) {
      throw new CloudAgentRequestRejected("invalid");
    }
    // The brief is text; a run must never report success on an attachment it never saw.
    if (request.images?.length) throw new CloudAgentRequestRejected("invalid");
    if (!sandbox.describe().capabilities.isolatedEgress) {
      throw new Error("the sandbox provider cannot isolate computer egress");
    }
    const token = await forgeToken(context.userId, context.spaceId);
    if (!token) throw new CloudAgentRequestRejected("invalid");

    const info = (await (
      await this.forge(token, `${this.config.forgeApi}/repos/${repository}`)
    ).json()) as { default_branch?: string };
    if (!info.default_branch) throw new CloudAgentRequestRejected("invalid");
    const commit = (await (
      await this.forge(
        token,
        `${this.config.forgeApi}/repos/${repository}/commits/${encodeURIComponent(info.default_branch)}`,
      )
    ).json()) as { sha?: string };
    if (!commit.sha || !/^[0-9a-f]{40}$/.test(commit.sha))
      throw new CloudAgentRetryLater("unavailable");
    const tarball = await this.forge(
      token,
      `${this.config.forgeApi}/repos/${repository}/tarball/${commit.sha}`,
      "application/vnd.github+json",
      180_000,
    );
    const declared = Number(tarball.headers.get("content-length") ?? "0");
    if (declared > this.config.maxSnapshotBytes) throw new CloudAgentRequestRejected("invalid");
    // Bounded while it is read, so a response with no length can't exhaust the worker.
    const snapshot = await readBodyCapped(tarball, this.config.maxSnapshotBytes).catch(() => {
      throw new CloudAgentRequestRejected("invalid");
    });

    const botId = `coding-${id}`;
    const started = this.now();
    const state: RunState = {
      id,
      userId: context.userId,
      spaceId: context.spaceId,
      repository,
      baseSha: commit.sha,
      botId,
      startedAt: started,
      deadline: started + this.config.deadlineMs,
      status: "running",
    };
    // Saved before the computer exists, so a crash mid-launch is torn down, not repeated.
    await this.saveState(state);
    const ctx = this.computerContext(context, botId);
    try {
      const homePath = path.join(this.deps.dataDir, "homes", botId);
      await mkdir(homePath, { recursive: true });
      const computer = await sandbox.provision({ botId, homePath, egress: "none" }, ctx);
      state.computer = computer;
      await this.saveState(state);
      await sandbox.prepare(computer, ctx);
      await this.assertIsolated(sandbox, computer, ctx);

      for (let offset = 0, part = 0; offset < snapshot.byteLength; offset += CHUNK_BYTES, part++) {
        await sandbox.writeFile(
          computer,
          {
            path: `${WORK_DIR}/snapshot.part-${String(part).padStart(4, "0")}`,
            content: snapshot.subarray(offset, offset + CHUNK_BYTES),
          },
          ctx,
        );
      }
      await sandbox.writeFile(
        computer,
        { path: `${WORK_DIR}/brief.md`, content: new TextEncoder().encode(request.prompt) },
        ctx,
      );
      await sandbox.writeFile(
        computer,
        {
          path: `${WORK_DIR}/run.sh`,
          content: new TextEncoder().encode(runScript()),
          executable: true,
        },
        ctx,
      );

      const capability = issueRelayCapability({
        key: this.config.relayKey,
        run: id,
        user: context.userId,
        model: this.config.model,
        ttlMs: this.config.deadlineMs,
        max: this.config.maxRequests,
        now: started,
      });
      state.capability = capability.token;
      await this.saveState(state);
      const env = {
        ...renderEnv(this.config.env, {
          relay_url: this.config.relayUrl,
          capability: capability.token,
        }),
        RAKAZO_CODING_TIMEOUT_S: String(Math.ceil(this.config.deadlineMs / 1000)),
      };
      // setsid -f detaches the run, and every stream it inherits is closed, so this exec
      // returns at once instead of holding the run's output open.
      await this.exec(
        sandbox,
        computer,
        [
          "bash",
          "-c",
          'setsid -f bash "$0" "$@" </dev/null >/dev/null 2>&1',
          `${WORK_DIR}/run.sh`,
          ...this.config.command,
        ],
        ctx,
        env,
      );
      state.runStarted = true;
      await this.saveState(state);
    } catch (error) {
      // A computer that wouldn't go keeps the run open; `get` retries until it does.
      if (!(await this.teardown(state, ctx, "failed", "launch failed"))) {
        return this.snapshotOf(state);
      }
      if (error instanceof CloudAgentRequestRejected || error instanceof CloudAgentRetryLater) {
        throw error;
      }
      getLogger().error("computer cloud agent launch failed", error);
      throw new CloudAgentRequestRejected("invalid");
    }
    return this.snapshotOf(state);
  }

  /** Fails unless both a public address and an external name are unreachable. */
  private async assertIsolated(
    sandbox: SandboxProvider,
    computer: ComputerRef,
    ctx: AdapterContext,
  ) {
    const output = await this.exec(
      sandbox,
      computer,
      [
        "bash",
        "-c",
        "curl -s -m 5 -o /dev/null https://1.1.1.1 && echo ROUTE; getent hosts example.com >/dev/null && echo DNS; true",
      ],
      ctx,
    );
    if (/ROUTE|DNS/.test(output)) {
      throw new Error(`computer egress is not isolated (${output.trim()})`);
    }
  }

  private async exec(
    sandbox: SandboxProvider,
    computer: ComputerRef,
    argv: string[],
    ctx: AdapterContext,
    env?: Record<string, string>,
  ) {
    let stdout = "";
    let code = 0;
    for await (const event of sandbox.execute(computer, { argv, env, timeoutMs: 30_000 }, ctx)) {
      if (event.type === "stdout") stdout += event.data;
      if (event.type === "exit") code = event.code;
    }
    if (code !== 0) throw new Error(`computer command exited ${code}`);
    return stdout;
  }

  async get(id: string, context: AdapterContext): Promise<CloudAgentSnapshot> {
    const state = await this.loadState(id);
    if (!state) throw new CloudAgentRequestRejected("not_found");
    if (state.status !== "running") return this.snapshotOf(state);
    const { sandbox } = this.requireRuntime();
    const ctx = this.computerContext(context, state.botId);
    if (state.pending) {
      await this.teardown(state, ctx, state.pending.status, state.pending.reason);
      return this.snapshotOf(state);
    }
    if (!state.computer || !state.runStarted) {
      await this.teardown(state, ctx, "failed", "launch interrupted");
      return this.snapshotOf(state);
    }
    const computer = state.computer;
    const read = (file: string, maxBytes: number) =>
      sandbox
        .readFile(computer, `${WORK_DIR}/${file}`, ctx, { maxBytes })
        .then((bytes) => new TextDecoder().decode(bytes))
        .catch(() => undefined);
    const exit = await read("exit", 64);
    if (exit === undefined) {
      if (this.now() > state.deadline + 60_000) {
        await this.teardown(state, ctx, "failed", "deadline passed");
      }
      return this.snapshotOf(state);
    }
    const error = await read("error", 4096);
    const numstat = await read("numstat.txt", 1024 * 1024);
    const diff = await read("diff.patch", this.config.maxDiffBytes + 1);
    let status: Phase = exit.trim() === "0" ? "finished" : "failed";
    let reason =
      error?.trim() || (status === "failed" ? `command exited ${exit.trim()}` : undefined);
    if (numstat === undefined || diff === undefined) {
      // Never report a result that wasn't read: the computer holds the only copy. A diff
      // that is simply too large is a failure now; anything else is retried.
      const size = await this.exec(
        sandbox,
        computer,
        ["bash", "-c", `wc -c < ${WORK_DIR}/diff.patch`],
        ctx,
      ).catch(() => undefined);
      if (numstat !== undefined && Number(size?.trim()) > this.config.maxDiffBytes) {
        status = "failed";
        reason = "the diff exceeds the size limit";
      } else if (this.now() <= state.deadline + RETRY_GRACE_MS) {
        return this.snapshotOf(state);
      } else {
        status = "failed";
        reason = "the result could not be read";
      }
    } else if (Buffer.byteLength(diff) > this.config.maxDiffBytes) {
      status = "failed";
      reason = "the diff exceeds the size limit";
    } else if (numstatHasBinary(numstat)) {
      status = "failed";
      reason = "the diff changes a binary file";
    }
    const output = (await read("output.txt", 1024 * 1024)) ?? "";
    const dir = this.runDir(id);
    // Kept whenever it was read within the limit, a failed run's partial work included.
    const kept = diff !== undefined && Buffer.byteLength(diff) <= this.config.maxDiffBytes;
    await writeFile(path.join(dir, "diff.patch"), kept ? diff : "", { mode: 0o600 });
    await writeFile(path.join(dir, "summary.md"), output.slice(-SUMMARY_BYTES), { mode: 0o600 });
    await this.teardown(state, ctx, status, reason);
    return this.snapshotOf(state);
  }

  async reply(
    _id: string,
    _request: CloudAgentReplyRequest,
    _context: AdapterContext,
  ): Promise<CloudAgentHandle> {
    // Each run is single-use; a follow-up is a new launch.
    throw new CloudAgentRequestRejected("expired");
  }

  async cancel(id: string, context: AdapterContext): Promise<CloudAgentSnapshot> {
    const state = await this.loadState(id);
    if (!state) throw new CloudAgentRequestRejected("not_found");
    if (state.status === "running") {
      await this.teardown(state, this.computerContext(context, state.botId), "cancelled");
    }
    return this.snapshotOf(state);
  }

  /** The kept summary and diff, for `cloud_agent_status`. Never throws. */
  async result(id: string): Promise<ComputerCloudAgentResult | undefined> {
    const state = await this.loadState(id).catch(() => undefined);
    if (!state) return undefined;
    const dir = this.runDir(id);
    const diff = await readFile(path.join(dir, "diff.patch"), "utf8").catch(() => "");
    const summary = await readFile(path.join(dir, "summary.md"), "utf8").catch(() => "");
    const diffBytes = Buffer.byteLength(diff);
    return {
      status: state.status,
      repository: state.repository,
      baseSha: state.baseSha,
      summary,
      diff: diffBytes > RESULT_DIFF_PREVIEW_BYTES ? diff.slice(0, RESULT_DIFF_PREVIEW_BYTES) : diff,
      diffBytes,
      diffTruncated: diffBytes > RESULT_DIFF_PREVIEW_BYTES,
      ...(state.reason ? { reason: state.reason } : {}),
    };
  }

  /**
   * Revoke the capability, destroy the computer, remove its home. The run turns terminal only
   * once the computer is gone: until then the intent is kept as `pending`, and every `get` and
   * `cancel` retries. Cleanup has its own bounded signal, so an expired poll can't fail it. A
   * lost reference is recovered by provisioning the run's bot id, which is idempotent. Past the
   * deadline by `RETRY_GRACE_MS`, it gives up and says so. Returns whether it finished.
   */
  private async teardown(
    state: RunState,
    context: AdapterContext,
    status: Phase,
    reason?: string,
  ): Promise<boolean> {
    const logger = getLogger();
    state.pending = { status, ...(reason ? { reason } : {}) };
    await this.saveState(state);
    const ctx: AdapterContext = {
      ...context,
      botId: state.botId,
      signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
    };
    if (state.capability && this.runtimeConfig) {
      await this.fetchImpl(`${this.config.relayUrl}/capabilities/revoke`, {
        method: "POST",
        headers: { authorization: `Bearer ${state.capability}` },
        signal: AbortSignal.timeout(10_000),
      }).catch((error) => logger.warn("relay capability revoke failed", error));
    }
    const { sandbox } = this.deps;
    let gone = !sandbox;
    if (sandbox) {
      try {
        const computer =
          state.computer ??
          (await sandbox.provision(
            {
              botId: state.botId,
              homePath: path.join(this.deps.dataDir, "homes", state.botId),
              egress: "none",
            },
            ctx,
          ));
        await sandbox.destroy(computer, ctx);
        gone = true;
      } catch (error) {
        logger.error("coding computer destroy failed", error);
      }
    }
    if (!gone && this.now() <= state.deadline + RETRY_GRACE_MS) return false;
    await rm(path.join(this.deps.dataDir, "homes", state.botId), {
      recursive: true,
      force: true,
    }).catch((error) => logger.error("coding computer home removal failed", error));
    state.status = status;
    state.capability = undefined;
    state.pending = undefined;
    state.reason = gone
      ? reason
      : [reason, "its computer could not be removed"].filter(Boolean).join("; ");
    if (!state.reason) delete state.reason;
    await this.saveState(state);
    return true;
  }
}
