# Fork patch set: data-handling banner

The web UI can show a persistent banner on every page that states the deployment's
data-handling rule. Nothing changes unless `DATA_NOTICE_ENABLED=true`. An unconfigured
instance renders exactly like upstream: no banner, no wrapper element, no layout change.

## Configuration

Set this on the API. The web app learns it from `/api/auth/capabilities`.

| Variable | Value |
| --- | --- |
| `DATA_NOTICE_ENABLED` | `true` shows the banner. `false`, empty or unset leaves it off. Any other value refuses startup, so a typo cannot hide the banner silently. |

The compose files do not pass `DATA_NOTICE_ENABLED` through; the deployment adds it.

## What it shows

Two lines, in `apps/web/src/components/DataNotice.tsx`:

1. *Do not paste client data (tenant user details, documents, questionnaire or evidence
   content, error text from tenant systems). Refer to tenants by slug.*
2. *Rakazo deletes chats, attachments, memory and computer workspaces within 30 days.
   Downloads, clipboard copies, screenshots and other copies on your device are outside
   that 30-day guarantee.*

The wording is policy and matches the deployment's staff guidance, so it is not
translated. The banner has no dismiss control, and it sits outside the app's error
boundary so the error page shows it too.

## Rules for changing the wording

- Change it together with the staff guidance and acceptable-use policy, never alone.
- Keep the 30-day figure in step with the deployment's retention controls.
- Never present a network control (host egress, DNS firewall, proxies) as a limit on
  what the browser can send, and never offer staff a route around the access proxy.
  The test `never presents a network control as a browser egress control` checks the
  obvious terms.
