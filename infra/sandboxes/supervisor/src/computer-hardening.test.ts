import { describe, expect, it } from "vitest";
import {
  computerMatchesCreateSpec,
  computerSpecMismatches,
  DOCKER_DEFAULT_MASKED_PATHS,
  type InspectedComputer,
  SPEC_FIELDS,
  UNCHECKED_CREATE_FIELDS,
} from "./computer-hardening.js";
import {
  COMPUTER_IMAGE,
  computerNetworkNameFor,
  containerCreateOptions,
  containerNameFor,
} from "./computer-spec.js";

// Fork patch: a computer is resumed only when it matches what create would build.

function expected(
  input: { networkMode?: string; volume?: boolean; publish?: boolean; dns?: string[] } = {},
) {
  return containerCreateOptions({
    name: containerNameFor("bot"),
    image: COMPUTER_IMAGE,
    botId: "bot",
    spaceId: "space",
    homePath: "/var/rakazo/homes/bot",
    ...(input.volume ? { homeVolume: { name: "rakazo_data", subpath: "homes/bot" } } : {}),
    networkMode: input.networkMode,
    publishControlPort: input.publish,
    dns: input.dns,
  });
}

/** What `docker inspect` reports for a container create built, daemon defaults included. */
function inspectedFrom(
  spec: ReturnType<typeof expected>,
  override: Record<string, unknown> = {},
): InspectedComputer {
  return {
    Config: { User: spec.User },
    NetworkSettings: { Networks: { [spec.HostConfig.NetworkMode]: {} } },
    HostConfig: {
      CapAdd: null,
      Devices: [],
      DeviceCgroupRules: null,
      DeviceRequests: null,
      PidMode: "",
      IpcMode: "private",
      UTSMode: "",
      UsernsMode: "",
      Privileged: false,
      ReadonlyRootfs: false,
      PublishAllPorts: false,
      MaskedPaths: [
        "/proc/acpi",
        "/proc/asound",
        "/proc/interrupts",
        "/proc/kcore",
        "/proc/keys",
        "/proc/latency_stats",
        "/proc/sched_debug",
        "/proc/scsi",
        "/proc/timer_list",
        "/proc/timer_stats",
        "/sys/devices/virtual/powercap",
        "/sys/firmware",
      ],
      Tmpfs: null,
      VolumesFrom: null,
      OomKillDisable: false,
      ...structuredClone(spec.HostConfig),
      ...override,
    },
  };
}

describe("computer spec on resume", () => {
  it.each([
    {},
    { networkMode: "rakazo_default" },
    { networkMode: computerNetworkNameFor("bot") },
    { volume: true },
    { publish: true },
  ])("a container create built matches (%j)", (input) => {
    const spec = expected(input);
    expect(computerSpecMismatches(inspectedFrom(spec), spec)).toEqual([]);
  });

  // The five review findings, one each.
  it("refuses a later no-new-privileges=false override", () => {
    const spec = expected();
    const inspected = inspectedFrom(spec, {
      SecurityOpt: ["no-new-privileges:true", "no-new-privileges:false"],
    });
    expect(computerSpecMismatches(inspected, spec)).toContain("SecurityOpt");
  });

  it.each([
    "disable",
    "label=disable",
    "label:disable",
    "seccomp=unconfined",
    "apparmor=unconfined",
  ])("refuses SecurityOpt %s added beside no-new-privileges", (option) => {
    const spec = expected();
    const inspected = inspectedFrom(spec, { SecurityOpt: ["no-new-privileges:true", option] });
    expect(computerSpecMismatches(inspected, spec)).toContain("SecurityOpt");
  });

  it.each([
    ["PidMode", "container:0123abcd"],
    ["IpcMode", "container:0123abcd"],
    ["PidMode", "host"],
    ["IpcMode", "host"],
    ["UTSMode", "host"],
    ["UsernsMode", "host"],
  ])("refuses %s %s", (field, value) => {
    const spec = expected();
    expect(computerSpecMismatches(inspectedFrom(spec, { [field]: value }), spec)).toContain(field);
  });

  it.each([
    ["an extra bind", { Binds: ["/var/rakazo/homes/bot:/home/rakazo", "/:/host"] }, "Binds"],
    ["another bot's home", { Binds: ["/var/rakazo/homes/other:/home/rakazo"] }, "Binds"],
    ["a read-only home", { Binds: ["/var/rakazo/homes/bot:/home/rakazo:ro"] }, "Binds"],
    [
      "an extra mount",
      { Mounts: [{ Type: "bind", Source: "/var/run/docker.sock", Target: "/run/docker.sock" }] },
      "Mounts",
    ],
    ["volumes from a peer", { VolumesFrom: ["peer"] }, "VolumesFrom"],
    ["a tmpfs", { Tmpfs: { "/run": "" } }, "Tmpfs"],
  ])("refuses %s", (_name, override, field) => {
    const spec = expected();
    expect(computerSpecMismatches(inspectedFrom(spec, override), spec)).toContain(field);
  });

  it("refuses an extra mount beside a named-volume home", () => {
    const spec = expected({ volume: true });
    const home = (spec.HostConfig.Mounts ?? [])[0];
    const inspected = inspectedFrom(spec, {
      Mounts: [home, { Type: "volume", Source: "rakazo_data", Target: "/mnt" }],
    });
    expect(computerSpecMismatches(inspected, spec)).toContain("Mounts");
  });

  it.each([
    ["Memory", 0],
    ["Memory", 2 ** 40],
    ["MemorySwap", -1],
    ["NanoCpus", 0],
    ["PidsLimit", -1],
    ["PidsLimit", undefined],
    ["ShmSize", 2 ** 34],
  ])("refuses %s=%s", (field, value) => {
    const spec = expected();
    expect(computerSpecMismatches(inspectedFrom(spec, { [field]: value }), spec)).toContain(field);
  });

  // The escalations the first version covered stay refused.
  it.each([
    ["Privileged", { Privileged: true }],
    ["CapAdd", { CapAdd: ["NET_ADMIN"] }],
    ["CapAdd", { CapAdd: ["CAP_NET_RAW"] }],
    ["CapAdd", { CapAdd: ["SYS_ADMIN"] }],
    ["CapDrop", { CapDrop: [] }],
    ["CapDrop", { CapDrop: ["NET_RAW"] }],
    ["SecurityOpt", { SecurityOpt: [] }],
    ["Devices", { Devices: [{ PathOnHost: "/dev/net/tun" }] }],
    ["DeviceCgroupRules", { DeviceCgroupRules: ["c 10:200 rwm"] }],
    ["DeviceRequests", { DeviceRequests: [{ Count: -1 }] }],
    ["NetworkMode", { NetworkMode: "host" }],
    ["ReadonlyPaths", { ReadonlyPaths: [] }],
    ["MaskedPaths", { MaskedPaths: [] }],
    ["Sysctls", { Sysctls: { "net.ipv4.ip_forward": "1" } }],
    ["OomKillDisable", { OomKillDisable: true }],
    ["PortBindings", { PortBindings: { "6080/tcp": [{ HostIp: "0.0.0.0", HostPort: "0" }] } }],
    ["PortBindings", { PortBindings: { "22/tcp": [{ HostIp: "127.0.0.1", HostPort: "0" }] } }],
  ])("refuses a different %s", (field, override) => {
    const spec = expected();
    expect(computerSpecMismatches(inspectedFrom(spec, override), spec)).toContain(field);
  });

  // Review round 2.
  it("refuses a container attached to a network beside its own", () => {
    const spec = expected({ networkMode: computerNetworkNameFor("bot") });
    const inspected = {
      ...inspectedFrom(spec),
      NetworkSettings: {
        Networks: { [computerNetworkNameFor("bot")]: {}, [computerNetworkNameFor("other")]: {} },
      },
    };
    expect(computerSpecMismatches(inspected, spec)).toEqual(["Networks"]);
  });

  it("refuses a container attached only to another network", () => {
    const spec = expected({ networkMode: computerNetworkNameFor("bot") });
    const inspected = {
      ...inspectedFrom(spec),
      NetworkSettings: { Networks: { bridge: {} } },
    };
    expect(computerSpecMismatches(inspected, spec)).toEqual(["Networks"]);
  });

  it("accepts a stopped container with no live attachment", () => {
    const spec = expected({ networkMode: computerNetworkNameFor("bot") });
    const inspected = { ...inspectedFrom(spec), NetworkSettings: { Networks: {} } };
    expect(computerSpecMismatches(inspected, spec)).toEqual([]);
  });

  it("refuses PublishAllPorts", () => {
    const spec = expected();
    expect(computerSpecMismatches(inspectedFrom(spec, { PublishAllPorts: true }), spec)).toEqual([
      "PublishAllPorts",
    ]);
  });

  it.each([
    [["/irrelevant"]],
    [["/proc/kcore"]],
    [DOCKER_DEFAULT_MASKED_PATHS.filter((path) => path !== "/proc/keys")],
  ])("refuses a partial mask list %j", (masked) => {
    const spec = expected();
    expect(computerSpecMismatches(inspectedFrom(spec, { MaskedPaths: masked }), spec)).toEqual([
      "MaskedPaths",
    ]);
  });

  it("accepts the default mask list with or without a newer daemon's extras", () => {
    const spec = expected();
    for (const masked of [[...DOCKER_DEFAULT_MASKED_PATHS], null]) {
      expect(computerSpecMismatches(inspectedFrom(spec, { MaskedPaths: masked }), spec)).toEqual(
        [],
      );
    }
  });

  it("refuses a different user and a missing HostConfig", () => {
    const spec = expected();
    expect(
      computerSpecMismatches({ ...inspectedFrom(spec), Config: { User: "0:0" } }, spec),
    ).toContain("User");
    expect(computerMatchesCreateSpec({ Config: { User: spec.User } }, spec)).toBe(false);
  });

  // Generic: whatever a field holds, a value create would not produce is refused.
  const PERTURBATIONS: Record<string, unknown> = {
    Privileged: true,
    CapAdd: ["CHOWN"],
    CapDrop: ["CHOWN"],
    SecurityOpt: ["no-new-privileges:true", "x"],
    Devices: [{ PathOnHost: "/dev/x" }],
    DeviceCgroupRules: ["a"],
    DeviceRequests: [{}],
    NetworkMode: "other",
    PidMode: "container:x",
    IpcMode: "container:x",
    UTSMode: "host",
    UsernsMode: "host",
    Binds: ["/x:/x"],
    Mounts: [{ Type: "bind", Source: "/x", Target: "/x" }],
    VolumesFrom: ["x"],
    Tmpfs: { "/x": "" },
    ReadonlyRootfs: true,
    ReadonlyPaths: [],
    MaskedPaths: [],
    Sysctls: { x: "1" },
    Memory: 1,
    MemorySwap: 1,
    NanoCpus: 1,
    PidsLimit: 1,
    ShmSize: 1,
    OomKillDisable: true,
    PublishAllPorts: true,
    PortBindings: { "1/tcp": [{ HostIp: "127.0.0.1", HostPort: "0" }] },
  };

  it("has a perturbation for every checked field", () => {
    expect(Object.keys(PERTURBATIONS).sort()).toEqual(Object.keys(SPEC_FIELDS).sort());
  });

  it.each(Object.keys(SPEC_FIELDS))("any change to %s replaces the computer", (field) => {
    for (const input of [{}, { volume: true }, { publish: true }]) {
      const spec = expected(input);
      const inspected = inspectedFrom(spec, { [field]: PERTURBATIONS[field] });
      expect(computerSpecMismatches(inspected, spec)).toEqual([field]);
    }
  });

  it("checks every field create sets", () => {
    for (const input of [{}, { volume: true }, { publish: true }, { dns: ["192.0.2.53"] }]) {
      for (const field of Object.keys(expected(input).HostConfig)) {
        expect(
          field in SPEC_FIELDS || UNCHECKED_CREATE_FIELDS.has(field),
          `${field} is set by create but neither checked nor exempt`,
        ).toBe(true);
      }
    }
  });
});
