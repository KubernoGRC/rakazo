import { describe, expect, it } from "vitest";
import { computerHardeningMatches, computerHardeningProblems } from "./computer-hardening.js";
import {
  COMPUTER_IMAGE,
  computerNetworkNameFor,
  containerCreateOptions,
  containerNameFor,
} from "./computer-spec.js";

// Fork patch: the computer must not be able to change host netfilter.
// That needs privileged mode, or NET_ADMIN / NET_RAW / SYS_ADMIN, none of which a
// computer may hold.

function createdHostConfig(networkMode?: string) {
  return containerCreateOptions({
    name: containerNameFor("bot"),
    image: COMPUTER_IMAGE,
    botId: "bot",
    spaceId: "space",
    homePath: "/var/rakazo/homes/bot",
    networkMode,
  }).HostConfig;
}

describe("computer hardening", () => {
  it.each([undefined, "rakazo_default", computerNetworkNameFor("bot")])(
    "create options pass the check (network %s)",
    (networkMode) => {
      const hostConfig = createdHostConfig(networkMode);
      expect(computerHardeningProblems(hostConfig)).toEqual([]);
      expect(hostConfig).not.toHaveProperty("Privileged");
      expect(hostConfig).not.toHaveProperty("CapAdd");
      expect(hostConfig).not.toHaveProperty("Devices");
    },
  );

  it.each([
    [{ Privileged: true }, /privileged/],
    [{ CapAdd: ["NET_ADMIN"] }, /NET_ADMIN/],
    [{ CapAdd: ["NET_RAW"] }, /NET_RAW/],
    [{ CapAdd: ["SYS_ADMIN"] }, /SYS_ADMIN/],
    [{ CapAdd: ["CAP_NET_ADMIN"] }, /CAP_NET_ADMIN/],
    [{ CapDrop: undefined }, /drop ALL/],
    [{ CapDrop: ["NET_RAW"] }, /drop ALL/],
    [{ SecurityOpt: [] }, /no-new-privileges/],
    [{ SecurityOpt: ["no-new-privileges:false"] }, /no-new-privileges/],
    [{ SecurityOpt: ["no-new-privileges:true", "seccomp=unconfined"] }, /unconfined/],
    [{ SecurityOpt: ["no-new-privileges:true", "apparmor:unconfined"] }, /unconfined/],
    [{ SecurityOpt: ["no-new-privileges:true", "label=disable"] }, /unconfined/],
    [{ Devices: [{ PathOnHost: "/dev/net/tun" }] }, /devices/],
    [{ DeviceCgroupRules: ["c 10:200 rwm"] }, /cgroup/],
    [{ DeviceRequests: [{ Count: -1 }] }, /device requests/],
    [{ NetworkMode: "host" }, /NetworkMode/],
    [{ PidMode: "host" }, /PidMode/],
    [{ IpcMode: "host" }, /IpcMode/],
    [{ UTSMode: "host" }, /UTSMode/],
    [{ UsernsMode: "host" }, /UsernsMode/],
  ])("refuses %j", (override, reason) => {
    const hostConfig = { ...createdHostConfig(), ...override };
    expect(computerHardeningMatches(hostConfig)).toBe(false);
    expect(computerHardeningProblems(hostConfig).join("; ")).toMatch(reason);
  });

  it("refuses a missing HostConfig", () => {
    expect(computerHardeningMatches(undefined)).toBe(false);
  });

  it("accepts the equals spelling of no-new-privileges", () => {
    expect(
      computerHardeningMatches({ CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges=true"] }),
    ).toBe(true);
  });
});
