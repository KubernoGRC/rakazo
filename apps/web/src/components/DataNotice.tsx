import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { fetchAuthCapabilities } from "../lib/auth-capabilities";

/**
 * Fork: the deployment's data-handling rule, shown on every page while the API
 * reports `dataNotice` (DATA_NOTICE_ENABLED). See docs/fork-data-notice.md.
 *
 * The wording is policy, reviewed with the staff acceptable-use policy, so it
 * is deliberately not translated: a translation would be an unreviewed restatement.
 * It names the 30-day service retention and the endpoint copies that sit outside
 * it. It must not present any network control as a limit on what the browser
 * itself can send.
 */
export const DATA_NOTICE_RULE =
  "Do not paste client data (tenant user details, documents, questionnaire or evidence content, error text from tenant systems). Refer to tenants by slug.";
export const DATA_NOTICE_RETENTION =
  "Rakazo deletes chats, attachments, memory and computer workspaces within 30 days. Downloads, clipboard copies, screenshots and other copies on your device are outside that 30-day guarantee.";

export function DataNoticeFrame({ children }: { children: ReactNode }) {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let active = true;
    fetchAuthCapabilities()
      .then((capabilities) => {
        if (active) setEnabled(capabilities.dataNotice === true);
      })
      // Nothing is usable while the API is unreachable, and the next page load asks again.
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  // Disabled, the tree is exactly upstream's: no wrapper, no layout change.
  if (!enabled) return <>{children}</>;
  return (
    <div className="flex h-full flex-col">
      <div
        className="shrink-0 border-warning/40 border-b bg-warning/10 px-4 py-2 text-[13px] leading-snug"
        data-kgrc-data-notice=""
        role="note"
        aria-label="Data handling"
      >
        <p className="font-medium">{DATA_NOTICE_RULE}</p>
        <p className="text-muted-foreground">{DATA_NOTICE_RETENTION}</p>
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
