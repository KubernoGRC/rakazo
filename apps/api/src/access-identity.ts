import type { AccessVerifier } from "@rakazo/auth";
import { SCREEN_TARGET_ENDPOINT } from "@rakazo/core/node/screen-capability";
import { getLogger } from "@rakazo/logging";
import type { MiddlewareHandler } from "hono";

/**
 * Fork: routes reachable without an access assertion under access identity.
 * Liveness probes and the public sign-in options carry no user data;
 * `/internal/health` already refuses anything that came through a proxy; the
 * screen target is called server to server and checks its own bearer secret.
 */
export const ACCESS_EXEMPT_PATHS: ReadonlySet<string> = new Set([
  "/health",
  "/ready",
  "/internal/health",
  "/api/auth/capabilities",
  SCREEN_TARGET_ENDPOINT,
]);

export const ACCESS_REQUIRED_BODY = {
  code: "ACCESS_IDENTITY_REQUIRED",
  message: "Sign in through your organisation's portal",
} as const;

/** Refuses every other request whose assertion does not verify. */
export function accessIdentityGate(verifier: AccessVerifier): MiddlewareHandler {
  return async (c, next) => {
    if (ACCESS_EXEMPT_PATHS.has(c.req.path)) return next();
    const verdict = await verifier.verify(c.req.raw.headers);
    if (!verdict.ok) {
      getLogger().warn("access identity refused", { reason: verdict.reason, route: c.req.path });
      return c.json(ACCESS_REQUIRED_BODY, 401);
    }
    await next();
  };
}

type BoundSession = {
  session: { id: string; userId: string };
  user: { email: string };
};

/**
 * A session counts only beside a verified assertion for the same email. A
 * mismatch ends the session, so a cookie cannot outlive a change of identity.
 */
export function createAccessSessionBinding(
  verifier: AccessVerifier,
  endSession: (session: { id: string; userId: string }) => Promise<void>,
) {
  return async (request: Request, current: BoundSession): Promise<boolean> => {
    const verdict = await verifier.verify(request.headers);
    if (!verdict.ok) return false;
    if (verdict.email === current.user.email.trim().toLowerCase()) return true;
    getLogger().warn("access identity changed; ending session", {
      "user.id": current.session.userId,
    });
    await endSession(current.session);
    return false;
  };
}
