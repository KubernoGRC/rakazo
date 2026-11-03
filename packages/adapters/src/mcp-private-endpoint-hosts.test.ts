import { describe, expect, it } from "vitest";
import { mcpStdioOptionsFromEnv } from "./mcp-connector.js";
import { mcpPrivateEndpointHostsFromEnv } from "./mcp-private-endpoint-hosts.js";
import { secureFetch } from "./mcp-transport.js";
import { assertSafeRemoteUrl, createSafeLookup } from "./remote-mcp.js";

const resolvesTo =
  (...addresses: string[]) =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }) as const);

const lookupError = (lookup: ReturnType<typeof createSafeLookup>, hostname: string) =>
  new Promise<Error | null>((resolve) => {
    lookup(hostname, { family: 0, all: false }, (error) => resolve(error));
  });

describe("MCP_PRIVATE_ENDPOINT_HOSTS", () => {
  it("is empty when unset or blank", () => {
    expect(mcpPrivateEndpointHostsFromEnv({})).toEqual([]);
    expect(mcpPrivateEndpointHostsFromEnv({ MCP_PRIVATE_ENDPOINT_HOSTS: " , " })).toEqual([]);
  });

  it("normalizes case, a trailing dot and duplicates", () => {
    expect(
      mcpPrivateEndpointHostsFromEnv({
        MCP_PRIVATE_ENDPOINT_HOSTS: " Runner.Example.Test. ,tools.example.test,runner.example.test",
      }),
    ).toEqual(["runner.example.test", "tools.example.test"]);
  });

  it.each([
    "10.0.4.20",
    "fd00::20",
    "[fd00::20]",
    "*.example.test",
    "runner",
    "runner.example.test:8443",
    "https://runner.example.test",
    "runner.example.test/mcp",
    "runner_1.example.test",
  ])("refuses %s", (entry) => {
    expect(() => mcpPrivateEndpointHostsFromEnv({ MCP_PRIVATE_ENDPOINT_HOSTS: entry })).toThrow(
      /not a DNS hostname/,
    );
  });

  it("reaches the connector options the API and worker share", () => {
    expect(
      mcpStdioOptionsFromEnv({ MCP_PRIVATE_ENDPOINT_HOSTS: "runner.example.test" })
        .privateEndpointHosts,
    ).toEqual(["runner.example.test"]);
  });
});

describe("pinned private endpoint list", () => {
  const policy = { privateEndpointHosts: ["runner.example.test", "tools.example.test"] };

  it("lets each listed host resolve to private addresses", async () => {
    for (const host of policy.privateEndpointHosts) {
      await expect(
        assertSafeRemoteUrl(`https://${host}/mcp`, resolvesTo("10.0.4.20"), policy),
      ).resolves.toEqual(new URL(`https://${host}/mcp`));
    }
  });

  it("keeps the pinned-host rules: HTTPS and private addresses only", async () => {
    await expect(
      assertSafeRemoteUrl("http://runner.example.test/mcp", resolvesTo("10.0.4.20"), policy),
    ).rejects.toThrow(/HTTPS/);
    for (const address of ["203.0.113.10", "169.254.169.254", "127.0.0.1", "100.64.0.1"]) {
      await expect(
        assertSafeRemoteUrl("https://runner.example.test/mcp", resolvesTo(address), policy),
      ).rejects.toThrow(/private addresses/);
    }
  });

  it.each([
    "https://other.example.test/mcp",
    "https://sub.runner.example.test/mcp",
    "https://runner.example.test.attacker.test/mcp",
  ])("still refuses any other host that resolves privately: %s", async (endpoint) => {
    await expect(assertSafeRemoteUrl(endpoint, resolvesTo("10.0.4.20"), policy)).rejects.toThrow(
      "Connector URL resolves to a private address",
    );
  });

  it("refuses private hosts when the list is empty", async () => {
    await expect(
      assertSafeRemoteUrl("https://runner.example.test/mcp", resolvesTo("10.0.4.20"), {
        privateEndpointHosts: [],
      }),
    ).rejects.toThrow("Connector URL resolves to a private address");
  });

  it("applies the list in the lookup used by the network connection", async () => {
    const lookup = createSafeLookup(resolvesTo("10.0.4.20"), policy);
    await expect(lookupError(lookup, "runner.example.test")).resolves.toBeNull();
    await expect(lookupError(lookup, "other.example.test")).resolves.toMatchObject({
      message: "Connector URL resolves to a private address",
    });
  });

  it("is honoured by the MCP session's request fetch", async () => {
    const seen: string[] = [];
    const fetch = async (input: string | URL | Request) => {
      seen.push(String(input instanceof Request ? input.url : input));
      return new Response("{}", { status: 200 });
    };
    const resource = new URL("https://runner.example.test/mcp");
    const network = { fetch, resolveHostname: resolvesTo("10.0.4.20") };
    await expect(
      secureFetch(
        resource,
        { privateEndpointHosts: ["runner.example.test"] },
        {},
        network,
      )(resource),
    ).resolves.toBeInstanceOf(Response);
    await expect(secureFetch(resource, {}, {}, network)(resource)).rejects.toThrow(
      /private address/,
    );
    expect(seen).toEqual(["https://runner.example.test/mcp"]);
  });
});
