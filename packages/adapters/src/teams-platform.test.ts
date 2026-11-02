import { describe, expect, it } from "vitest";
import { ChatSdkMessagingSurface } from "./chat-sdk-surface.js";
import { messagingEnvFromProcess, messagingPlatformsFromEnv } from "./messaging-platforms.js";
import { teamsActivityRefusal, teamsDirectoryAddress, teamsPlatform } from "./teams-platform.js";

// Fake credentials: the adapter is constructed offline and never reaches Microsoft.
const TENANT = "11111111-2222-3333-4444-555555555555";
const OTHER_TENANT = "99999999-8888-7777-6666-555555555555";
const OBJECT_ID = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
const credentials = {
  appId: "00000000-0000-0000-0000-00000000a99d",
  appPassword: "pw",
  tenantId: TENANT,
};

function activity(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "message",
    id: "1",
    text: "hello",
    serviceUrl: "https://smba.trafficmanager.net/teams/",
    from: { id: "29:teams-user", aadObjectId: OBJECT_ID },
    recipient: { id: `28:${credentials.appId}` },
    conversation: { id: "a:personal", conversationType: "personal", tenantId: TENANT },
    channelData: { tenant: { id: TENANT } },
    ...overrides,
  };
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://bridge.example.test/api/v1/messaging/webhook/teams", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("Teams mounting", () => {
  const env = {
    TEAMS_APP_ID: credentials.appId,
    TEAMS_APP_PASSWORD: "pw",
    TEAMS_APP_TENANT_ID: TENANT,
  };

  it("mounts only with the app id, password and tenant all set", () => {
    const providers = (values: Record<string, string | undefined>) =>
      messagingPlatformsFromEnv(messagingEnvFromProcess(values)).map((p) => p.provider);
    expect(providers(env)).toEqual(["teams"]);
    for (const key of Object.keys(env)) {
      expect(providers({ ...env, [key]: " " }), key).toEqual([]);
    }
  });

  it("is personal conversations only", () => {
    expect(teamsPlatform(credentials).capabilities).toMatchObject({ direct: true, groups: false });
  });
});

describe("Teams tenant pinning", () => {
  const surface = () => new ChatSdkMessagingSurface([teamsPlatform(credentials)]);

  it.each([
    [
      "another tenant",
      activity({
        conversation: { id: "a:x", conversationType: "personal", tenantId: OTHER_TENANT },
        channelData: { tenant: { id: OTHER_TENANT } },
      }),
    ],
    ["no tenant", activity({ conversation: { id: "a:x" }, channelData: {} })],
    ["tenant fields that disagree", activity({ channelData: { tenant: { id: OTHER_TENANT } } })],
    ["a message with no directory sender", activity({ from: { id: "29:teams-user" } })],
    ["a body that is not an activity", "not json"],
  ])("refuses %s before the adapter sees it", async (_label, body) => {
    // A bearer that would fail verification anyway: the 403 shows the
    // refusal came first, from the tenant pin rather than the JWT check.
    const response = await surface().handleWebhook(
      "teams",
      post(body, { authorization: "Bearer x" }),
    );
    expect(response?.status).toBe(403);
  });

  it("leaves verification to the adapter for this tenant's activities", async () => {
    // Unsigned, so the adapter's native Bot Framework JWT check refuses it.
    const response = await surface().handleWebhook("teams", post(activity()));
    expect(response?.status).toBe(401);
  });

  it("compares tenants without regard to case", () => {
    expect(
      teamsActivityRefusal(
        activity({ conversation: { id: "a:x", tenantId: TENANT.toUpperCase() } }),
        TENANT,
      ),
    ).toBeNull();
  });
});

describe("Teams sender address", () => {
  it("is the sender's directory tenant and object id", () => {
    expect(teamsDirectoryAddress(activity())).toBe(`${TENANT}:${OBJECT_ID.toLowerCase()}`);
    const enrich = teamsPlatform(credentials).enrichTeamRoom!;
    const base = { from: "29:teams-user" } as Parameters<typeof enrich>[1];
    expect(enrich(activity(), base)).toEqual({ from: `${TENANT}:${OBJECT_ID.toLowerCase()}` });
  });

  it("is absent without a directory sender", () => {
    expect(teamsDirectoryAddress(activity({ from: { id: "29:teams-user" } }))).toBeNull();
  });
});
