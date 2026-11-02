import { createTeamsAdapter } from "@chat-adapter/teams";
import { getLogger } from "@rakazo/logging";
import type { Adapter, WebhookOptions } from "chat";
import type { MessagingPlatform } from "./chat-sdk-surface.js";

/** Credentials of a single-tenant Azure Bot (TEAMS_APP_*). */
export interface TeamsCredentials {
  appId: string;
  appPassword: string;
  tenantId: string;
}

/**
 * Fork: Microsoft Teams as a messaging surface (docs/fork-teams.md).
 *
 * Single-tenant, personal (1:1) conversations only. The adapter verifies
 * every inbound request's Bot Framework JWT; that proves Microsoft sent it,
 * not which organisation the sender belongs to, so this platform also
 * refuses any activity from another directory tenant before the adapter
 * sees it. A sender is addressed by their directory tenant and object id,
 * not by Teams' per-bot user id, so a linked identity records who the person
 * is in the directory and stays valid if the bot is registered again.
 */
export function teamsPlatform(credentials: TeamsCredentials): MessagingPlatform {
  const tenantId = credentials.tenantId.toLowerCase();
  const adapter = createTeamsAdapter({
    appType: "SingleTenant",
    appId: credentials.appId,
    appPassword: credentials.appPassword,
    appTenantId: credentials.tenantId,
  });
  const handleWebhook = adapter.handleWebhook.bind(adapter);
  Object.assign(adapter, {
    handleWebhook: async (request: Request, options?: WebhookOptions) => {
      const refusal = teamsActivityRefusal(await bodyOf(request), tenantId);
      if (refusal) {
        getLogger().warn("teams activity refused", { reason: refusal });
        return new Response("Forbidden", { status: 403 });
      }
      return handleWebhook(request, options);
    },
  } satisfies Pick<Adapter, "handleWebhook">);
  return {
    provider: "teams",
    capabilities: { direct: true, groups: false, receipt: null },
    adapter,
    enrichTeamRoom: (raw) => {
      const from = teamsDirectoryAddress(raw);
      return from ? { from } : {};
    },
  };
}

/**
 * Why an inbound activity is refused before verification, or null to let the
 * adapter verify and handle it. Refusing early is safe whatever the body
 * says; accepting still requires the adapter's JWT check.
 */
export function teamsActivityRefusal(payload: unknown, tenantId: string): string | null {
  const activity = asRecord(payload);
  if (!activity) return "not an activity";
  const tenant = activityTenantId(activity);
  if (!tenant) return "no tenant";
  if (tenant !== tenantId) return "other tenant";
  // A message must name its sender in the directory: that id is what a
  // linked identity is keyed on.
  if (activity.type === "message" && !directoryObjectId(activity)) return "no directory sender";
  return null;
}

/** `<tenant id>:<object id>`, lower-cased, for an activity that carries both. */
export function teamsDirectoryAddress(raw: unknown): string | null {
  const activity = asRecord(raw);
  if (!activity) return null;
  const tenant = activityTenantId(activity);
  const objectId = directoryObjectId(activity);
  return tenant && objectId ? `${tenant}:${objectId}` : null;
}

function activityTenantId(activity: Record<string, unknown>): string | null {
  const conversation = asRecord(activity.conversation);
  const channelTenant = asRecord(asRecord(activity.channelData)?.tenant);
  const tenants = [conversation?.tenantId, channelTenant?.id]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) => value.toLowerCase());
  // Both fields name the tenant; an activity whose two disagree is not trusted.
  if (tenants.length === 0 || tenants.some((value) => value !== tenants[0])) return null;
  return tenants[0]!;
}

function directoryObjectId(activity: Record<string, unknown>): string | null {
  const objectId = asRecord(activity.from)?.aadObjectId;
  return typeof objectId === "string" && objectId ? objectId.toLowerCase() : null;
}

async function bodyOf(request: Request): Promise<unknown> {
  try {
    return JSON.parse(await request.clone().text());
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}
