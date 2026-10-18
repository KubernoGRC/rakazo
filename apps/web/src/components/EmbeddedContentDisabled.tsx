// Fork: placeholder for embedded documents; see docs/fork-browser-controls.md.
import { Trans } from "@lingui/react/macro";

/**
 * Stands where an iframe would be. The page's CSP has `frame-src 'none'`, so an iframe would only
 * render empty; this says why instead.
 */
export function EmbeddedContentDisabled({ className }: { className?: string }) {
  return (
    <div
      className={
        className ??
        "grid h-full w-full place-items-center px-6 text-center text-sm text-muted-foreground/80"
      }
      data-embedded-content="disabled"
    >
      <Trans>Embedded previews are turned off in this deployment.</Trans>
    </div>
  );
}
