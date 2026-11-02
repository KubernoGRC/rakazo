# Fork patch set: Microsoft Teams messaging surface

Staff can talk to their own Rakazo bot in a 1:1 Microsoft Teams chat. The surface uses the
official Chat SDK adapter, `@chat-adapter/teams`, at the same version as `chat`. It mounts
like every other messaging platform: only when its full credential set is present. Nothing
changes unless all three `TEAMS_APP_*` values are set.

## Configuration

Set these on both the API (inbound) and the worker (replies). Like the other fork settings,
the compose files don't carry them; the deployment's own compose overlay or env file passes
them (`infra/updater/src/compose-env.test.ts` lists them as deployment-supplied).

| Variable | Meaning |
| --- | --- |
| `TEAMS_APP_ID` | The Azure Bot's Microsoft app id (the bot's Entra app registration). |
| `TEAMS_APP_PASSWORD` | That app registration's client secret. Keep it with the deployment's other credentials. |
| `TEAMS_APP_TENANT_ID` | The directory (tenant) id the app registration lives in. |

The bot is always **single-tenant**. The bot's messaging endpoint is
`/api/v1/messaging/webhook/teams`. Under [trusted access identity](fork-access-identity.md),
also set `ACCESS_IDENTITY_EXEMPT_WEBHOOKS=teams` (see [below](#behind-an-access-proxy)).

## Behaviour

- **Every inbound request is verified by the adapter**, with its native Bot Framework JWT
  check (issuer, audience = the app id, Microsoft's signing keys, and the activity's
  service URL). No custom verifier is configured.
- **Other tenants are refused.** A valid Bot Framework token shows that Microsoft sent the
  activity, not which organisation the sender belongs to. Before the adapter sees a request,
  the surface refuses (403) an activity:
  - whose tenant (`conversation.tenantId` and `channelData.tenant.id`) isn't
    `TEAMS_APP_TENANT_ID`;
  - that names no tenant, or names two different ones;
  - that is a message without the sender's directory object id (`from.aadObjectId`).

  Refusing before verification is safe whatever the body says. Accepting still needs the
  adapter's check.
- **A sender is addressed by their directory identity.** A Teams sender's address is
  `<tenant id>:<object id>`, lower-cased, not Teams' per-bot user id (`29:…`). Linking with a
  link code therefore records the person's tenant and Entra object id on their
  `MessagingIdentity`. The binding stays valid if the bot is registered again under a new app
  id. Inbound resolves the identity by that address, so a run belongs to the linked user and
  uses only their own connections. Unlinked senders get no run, as on every other surface.
- **Personal conversations only.** Group chats and channels are dropped (`groups: false`).
- Replies go to the conversation learned from the sender's last inbound message.
  Teams can't open a 1:1 chat from the directory address alone, so a Teams identity always
  starts with an inbound message (the link code).
- The bot needs no Microsoft Graph permissions. The adapter's Graph features (message
  history, file downloads from SharePoint) are unused and fail without them.

## Behind an access proxy

Under trusted access identity every route needs a signed access assertion, and a vendor's
server-to-server webhook can't carry one. `ACCESS_IDENTITY_EXEMPT_WEBHOOKS` lists messaging
providers, by name, whose webhook skips that check because the provider's adapter
authenticates it instead. The exemption is exactly `POST /api/v1/messaging/webhook/<name>`:
not other methods, not paths below it, and not the legacy `/api/v1/phone/webhook`. The
access proxy must let that one path through too (a bypass for exactly that path).

## Where it touches upstream files

- `packages/adapters/src/teams-platform.ts` (new): the platform, the tenant pin and the
  sender address.
- `packages/adapters/src/messaging-platforms.ts`: the three settings and the mount.
- `packages/adapters/package.json`: the `@chat-adapter/teams` dependency.
- `apps/api/src/env.ts`: the settings, and `ACCESS_IDENTITY_EXEMPT_WEBHOOKS`.
- `apps/api/src/access-identity.ts` and `apps/api/src/app.ts`: the webhook exemption.
