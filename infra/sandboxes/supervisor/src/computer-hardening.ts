/**
 * Fork patch: never resume a computer that is not the computer create would build.
 *
 * `containerCreateOptions` is the single definition of a computer's privileges:
 * no capabilities, `no-new-privileges`, no devices, its own namespaces, exactly
 * its home mounted, resource ceilings. Upstream's resume path reused a managed
 * container after checking only its image, user, network and home mount, so a
 * container created some other way (an older build, a hand-run `docker run`, a
 * compose override) was started with whatever it had. A privileged computer, or
 * one holding NET_ADMIN, NET_RAW or SYS_ADMIN, can rewrite host netfilter and
 * undo the host's per-computer network isolation. Extra mounts expose other
 * bots' homes, and missing ceilings let one computer starve the host.
 *
 * The check is structural, not a deny-list. The expected HostConfig is built by
 * the same function create uses, and the inspected container must match it on
 * every field in `SPEC_FIELDS`. A field create leaves unset must hold its
 * isolated default. A deny-list misses the next spelling of the same escalation.
 *
 * Upstream never creates a container that fails this, so an otherwise unpatched
 * instance resumes exactly as before.
 */

type Json = unknown;

/** What `docker inspect` returns that this check reads. */
export interface InspectedComputer {
  Config?: { User?: string | null } | null;
  HostConfig?: object | null;
}

/** What `containerCreateOptions` returns that this check reads. */
export interface ExpectedComputer {
  User?: string;
  HostConfig: object;
}

type FieldCheck = (actual: Json, expected: Json) => boolean;

const list = (value: Json): unknown[] => (Array.isArray(value) ? value : []);
const record = (value: Json): Record<string, Json> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : {};
const canonical = (value: Json): string =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
const sameSet = (a: unknown[], b: unknown[]) => {
  const left = new Set(a.map(canonical));
  const right = new Set(b.map(canonical));
  return left.size === right.size && [...left].every((value) => right.has(value));
};

/** Exact set equality; absent and empty are the same. */
const exactSet: FieldCheck = (actual, expected) => sameSet(list(actual), list(expected));

/** Capability names compare case-insensitively, with or without the CAP_ prefix. */
const capabilitySet: FieldCheck = (actual, expected) => {
  const norm = (value: Json) =>
    list(value).map((cap) => String(cap).toUpperCase().replace(/^CAP_/, ""));
  return sameSet(norm(actual), norm(expected));
};

const flag: FieldCheck = (actual, expected) => Boolean(actual) === Boolean(expected);
const exact: FieldCheck = (actual, expected) => actual === expected;
const sameRecord: FieldCheck = (actual, expected) =>
  canonical(record(actual)) === canonical(record(expected));

/**
 * A namespace mode that create leaves unset must be one of Docker's private
 * spellings. Anything else fails, including `host` and `container:<id>`.
 */
const namespace =
  (privateDefaults: string[]): FieldCheck =>
  (actual, expected) =>
    expected === undefined || expected === ""
      ? privateDefaults.includes(String(actual ?? ""))
      : actual === expected;

/** Every path create makes read-only stays read-only; more is fine. */
const supersetOf: FieldCheck = (actual, expected) => {
  const have = new Set(list(actual).map(String));
  return list(expected).every((path) => have.has(String(path)));
};

/** Unset means the daemon's default mask list. An explicit empty list unmasks /proc. */
const maskedPaths: FieldCheck = (actual, expected) =>
  expected === undefined ? actual == null || list(actual).length > 0 : exactSet(actual, expected);

/** Mounts compare on what decides what the computer can reach and write. */
const mounts: FieldCheck = (actual, expected) => {
  const norm = (value: Json) =>
    list(value).map((entry) => {
      const mount = record(entry);
      const options = record(mount.VolumeOptions);
      const bind = record(mount.BindOptions);
      return {
        Type: mount.Type ?? "",
        Source: mount.Source ?? "",
        Target: mount.Target ?? "",
        ReadOnly: Boolean(mount.ReadOnly),
        Subpath: options.Subpath ?? "",
        Propagation: bind.Propagation ?? "",
      };
    });
  return sameSet(norm(actual), norm(expected));
};

/**
 * No port is published that create does not publish, and none on a host
 * address other than create's.
 */
const portBindings: FieldCheck = (actual, expected) => {
  const want = record(expected);
  return Object.entries(record(actual)).every(([port, bindings]) => {
    if (!list(bindings).length) return true;
    const hostIps = new Set(list(want[port]).map((binding) => record(binding).HostIp));
    return (
      hostIps.size > 0 && list(bindings).every((binding) => hostIps.has(record(binding).HostIp))
    );
  });
};

/**
 * Every security- and resource-relevant HostConfig field, and how it is
 * compared. A field missing here is not checked. A test fails when create sets a
 * field that is neither listed here nor in `UNCHECKED_CREATE_FIELDS`.
 */
export const SPEC_FIELDS: Readonly<Record<string, FieldCheck>> = {
  Privileged: flag,
  CapAdd: capabilitySet,
  CapDrop: capabilitySet,
  SecurityOpt: exactSet,
  Devices: exactSet,
  DeviceCgroupRules: exactSet,
  DeviceRequests: exactSet,
  NetworkMode: exact,
  PidMode: namespace(["", "private"]),
  IpcMode: namespace(["", "private", "shareable"]),
  UTSMode: namespace(["", "private"]),
  UsernsMode: namespace(["", "private"]),
  Binds: exactSet,
  Mounts: mounts,
  VolumesFrom: exactSet,
  Tmpfs: sameRecord,
  ReadonlyRootfs: flag,
  ReadonlyPaths: supersetOf,
  MaskedPaths: maskedPaths,
  Sysctls: sameRecord,
  Memory: exact,
  MemorySwap: exact,
  NanoCpus: exact,
  PidsLimit: exact,
  ShmSize: exact,
  OomKillDisable: flag,
  PortBindings: portBindings,
};

/** Create fields that grant nothing, so the check does not compare them. */
export const UNCHECKED_CREATE_FIELDS: ReadonlySet<string> = new Set(["AutoRemove"]);

/** Returns the fields that differ from what create would build; empty means it matches. */
export function computerSpecMismatches(
  inspected: InspectedComputer,
  expected: ExpectedComputer,
): string[] {
  if (!inspected.HostConfig) return ["HostConfig"];
  const actual = record(inspected.HostConfig);
  const want = record(expected.HostConfig);
  const mismatches = Object.entries(SPEC_FIELDS)
    .filter(([field, check]) => !check(actual[field], want[field]))
    .map(([field]) => field);
  if ((inspected.Config?.User ?? undefined) !== expected.User) mismatches.unshift("User");
  return mismatches;
}

export function computerMatchesCreateSpec(
  inspected: InspectedComputer,
  expected: ExpectedComputer,
): boolean {
  return computerSpecMismatches(inspected, expected).length === 0;
}
