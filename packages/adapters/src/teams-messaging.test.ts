import type { IncomingMessage, Server } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { AdapterContext, MessagingInboundEvent } from "@rakazo/adapter-kit";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ChatSdkMessagingSurface } from "./chat-sdk-surface.js";
import { messagingPlatformsFromEnv } from "./messaging-platforms.js";

// Exercise the real adapter and Teams SDK end to end, offline. Only two
// boundaries are replaced: Microsoft's token issuance and JWT check (the
// adapter's own `token` and `webhookVerifier` options), and the Bot Connector
// service, which is a loopback server named as the activity's serviceUrl.
const TENANT = "aaaaaaaa-2222-4333-8444-55555555555b";
const OBJECT_ID = "bbbbbbbb-3333-4444-8555-66666666666c";
const APP_ID = "00000000-0000-4000-8000-00000000a99d";
// The SDK decodes (never verifies) the bot token it is handed, so the fake one
// is JWT-shaped: unsigned, for this app, valid for an hour.
const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const BOT_TOKEN = [
  segment({ alg: "none", typ: "JWT" }),
  segment({
    aud: "https://api.botframework.com",
    appid: APP_ID,
    exp: Math.floor(Date.now() / 1000) + 3600,
  }),
  "",
].join(".");

const context: AdapterContext = {
  operationId: "op-test",
  traceId: "trace-test",
  spaceId: "space-test",
  userId: "user-test",
  signal: new AbortController().signal,
};

interface ConnectorCall {
  method: string;
  path: string;
  authorization: string | undefined;
  body: unknown;
}

let connector: Server;
let serviceUrl: string;
const calls: ConnectorCall[] = [];

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : null;
}

beforeAll(async () => {
  connector = createServer((request, response) => {
    void readJson(request).then((body) => {
      calls.push({
        method: request.method ?? "",
        path: request.url ?? "",
        authorization: request.headers.authorization,
        body,
      });
      response.setHeader("content-type", "application/json");
      // The members lookup answers with the sender's directory entry; every
      // send answers with a new activity id.
      response.end(
        JSON.stringify(
          request.url?.includes("/members/")
            ? { id: "29:teams-user", name: "Staff Member", email: "staff@example.test" }
            : { id: "reply-1" },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => connector.listen(0, "127.0.0.1", resolve));
  serviceUrl = `http://127.0.0.1:${(connector.address() as AddressInfo).port}/teams/`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => connector.close(() => resolve()));
});

beforeEach(() => {
  calls.length = 0;
});

function createSurface() {
  const platforms = messagingPlatformsFromEnv(
    { teamsAppId: APP_ID, teamsAppPassword: "test-password", teamsAppTenantId: TENANT },
    { teamsTransport: { token: () => BOT_TOKEN, webhookVerifier: () => true } },
  );
  const surface = new ChatSdkMessagingSurface(platforms);
  const events: MessagingInboundEvent[] = [];
  surface.onInbound(async (event) => {
    events.push(event);
  });
  return { surface, events };
}

function activity(conversationType: "personal" | "groupChat", id: string) {
  return {
    type: "message",
    id,
    text: "hello",
    timestamp: "2026-11-01T00:00:00.000Z",
    channelId: "msteams",
    serviceUrl,
    from: { id: "29:teams-user", name: "Staff Member", aadObjectId: OBJECT_ID },
    recipient: { id: `28:${APP_ID}`, name: "Rakazo" },
    conversation: {
      id: conversationType === "personal" ? "a:personal-chat" : "19:group@thread.v2",
      conversationType,
      isGroup: conversationType !== "personal",
      tenantId: TENANT,
    },
    channelData: { tenant: { id: TENANT } },
  };
}

function webhook(body: unknown) {
  return new Request("https://rakazo.test/api/v1/messaging/webhook/teams", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test" },
    body: JSON.stringify(body),
  });
}

describe("Teams messaging conformance (offline)", () => {
  it("delivers a personal message as a direct message from the directory identity", async () => {
    const { surface, events } = createSurface();
    const response = await surface.handleWebhook("teams", webhook(activity("personal", "m-1")));
    expect(response?.status).toBeLessThan(300);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "message",
      provider: "teams",
      isDirect: true,
      from: `${TENANT}:${OBJECT_ID}`,
      content: "hello",
    });
    await surface.shutdown();
  });

  it("drops group conversations", async () => {
    const { surface, events } = createSurface();
    const response = await surface.handleWebhook("teams", webhook(activity("groupChat", "m-2")));
    expect(response?.status).toBeLessThan(300);
    expect(events).toEqual([]);
    await surface.shutdown();
  });

  it("replies through the Bot Connector with the bot's token", async () => {
    const inbound = createSurface();
    await inbound.surface.handleWebhook("teams", webhook(activity("personal", "m-3")));
    const event = inbound.events[0];
    expect(event?.type).toBe("message");
    await inbound.surface.shutdown();
    if (event?.type !== "message") return;

    // The worker delivers replies from its own adapter instance, with only
    // the thread id the API stored.
    calls.length = 0;
    const outbound = createSurface();
    await outbound.surface.sendToThread({ threadId: event.threadId, body: "hi there" }, context);
    const send = calls.find(
      (call) =>
        call.method === "POST" &&
        call.path.endsWith("/teams/v3/conversations/a:personal-chat/activities"),
    );
    expect(send?.authorization).toBe(`Bearer ${BOT_TOKEN}`);
    expect(send?.body).toMatchObject({ type: "message", text: "hi there" });
    await outbound.surface.shutdown();
  });
});
