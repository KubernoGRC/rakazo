/**
 * Fork patch: refuse to resume a computer whose runtime privileges
 * exceed what `containerCreateOptions` grants.
 *
 * The create path already drops every capability, sets `no-new-privileges`
 * and adds no devices. The resume path only compared image, user, network and
 * mounts, so a `rakazo.managed` container created some other way (an older
 * build, a hand-run `docker run`, a compose override) was started as it was,
 * privileged or not. A computer holding NET_ADMIN, NET_RAW or SYS_ADMIN, or
 * running privileged, can rewrite the host's netfilter rules and undo the
 * host's per-computer network isolation. Such a container is replaced instead.
 *
 * Upstream never creates a container that fails this check, so on an unpatched
 * deployment it changes nothing.
 */

/** The HostConfig fields this check reads; Docker's inspect output carries more. */
interface HostConfig {
  Privileged?: boolean | null;
  CapAdd?: string[] | null;
  CapDrop?: string[] | null;
  SecurityOpt?: string[] | null;
  Devices?: unknown[] | null;
  DeviceCgroupRules?: string[] | null;
  DeviceRequests?: unknown[] | null;
  NetworkMode?: string | null;
  PidMode?: string | null;
  IpcMode?: string | null;
  UTSMode?: string | null;
  UsernsMode?: string | null;
}

const HOST_NAMESPACE = "host";

/** Security options that switch off a confinement layer outright. */
const UNCONFINED_OPTION = /^(seccomp|apparmor|label)[=:](unconfined|disable)$/i;

/** Returns the reasons a computer's HostConfig is not hardened; empty means hardened. */
export function computerHardeningProblems(hostConfig: HostConfig | undefined): string[] {
  if (!hostConfig) return ["HostConfig is missing"];
  const problems: string[] = [];
  if (hostConfig.Privileged) problems.push("privileged");
  if (hostConfig.CapAdd?.length) problems.push(`adds capabilities ${hostConfig.CapAdd.join(",")}`);
  if (!hostConfig.CapDrop?.some((cap) => cap.toUpperCase() === "ALL")) {
    problems.push("does not drop ALL capabilities");
  }
  const securityOpt = hostConfig.SecurityOpt ?? [];
  if (!securityOpt.some((option) => /^no-new-privileges(:true|=true)?$/i.test(option))) {
    problems.push("no-new-privileges is not set");
  }
  const unconfined = securityOpt.filter((option) => UNCONFINED_OPTION.test(option));
  if (unconfined.length) problems.push(`unconfined: ${unconfined.join(",")}`);
  if (hostConfig.Devices?.length) problems.push("host devices are mapped");
  if (hostConfig.DeviceCgroupRules?.length) problems.push("device cgroup rules are set");
  if (hostConfig.DeviceRequests?.length) problems.push("device requests are set");
  for (const [field, value] of [
    ["NetworkMode", hostConfig.NetworkMode],
    ["PidMode", hostConfig.PidMode],
    ["IpcMode", hostConfig.IpcMode],
    ["UTSMode", hostConfig.UTSMode],
    ["UsernsMode", hostConfig.UsernsMode],
  ] as const) {
    if (value === HOST_NAMESPACE) problems.push(`${field} shares the host namespace`);
  }
  return problems;
}

export function computerHardeningMatches(hostConfig: HostConfig | undefined): boolean {
  return computerHardeningProblems(hostConfig).length === 0;
}
