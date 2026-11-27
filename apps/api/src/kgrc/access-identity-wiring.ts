/**
 * Fork-owned (see docs/kgrc-fork.md): wires trusted access identity into the API.
 *
 * Everything the fork adds to `app.ts` for access identity lives here, so that
 * file carries only one-line call sites at stable anchors and upstream merges
 * rarely touch fork lines. Behaviour is described in docs/fork-access-identity.md.
 */
import type { AccessVerifier } from "@rakazo/auth";
import { ACCESS_PROVIDER_ID, createAccessVerifier } from "@rakazo/auth";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { Hono } from "hono";
import { accessIdentityGate, createAccessSessionBinding } from "../auth/access-identity.js";
import type { AppEnv } from "../env.js";

type SessionLike = { session: { id: string; userId: string }; user?: unknown };

export interface ForkAccess {
  /** Passed to `createAuth` as `accessIdentity`; undefined when access identity is off. */
  readonly verifier: AccessVerifier | undefined;
  /** Spread into the `/api/auth/capabilities` reply. Empty when access identity is off. */
  readonly capabilities: { accessIdentity?: true; accessLogoutUrl?: string };
  /** Health's `unready` check: without a usable key set every assertion is refused. */
  readonly unready: (() => Promise<string | undefined>) | undefined;
  /** Under access identity every later route needs a verified assertion. */
  mountGate(app: Hono): void;
  /**
   * Wraps the session reader: a session without a user reads as none, and under
   * access identity a session counts only for the access subject it belongs to.
   */
  bindSession<A extends unknown[], S extends SessionLike>(
    read: (request: Request, ...rest: A) => Promise<S | null | undefined>,
  ): (request: Request, ...rest: A) => Promise<S | null>;
  /** Ends a session bound to another identity before Better Auth reads it. */
  beforeAuthHandler(
    request: Request,
    getSession: (headers: Headers) => Promise<SessionLike | null | undefined>,
  ): Promise<void>;
}

export function createForkAccess(
  env: Pick<AppEnv, "accessIdentity" | "accessExemptWebhooks">,
  {
    prisma,
    pushTokens,
  }: {
    prisma: PrismaClient;
    pushTokens: { endSession(userId: string, sessionId: string): Promise<unknown> };
  },
): ForkAccess {
  const verifier = env.accessIdentity ? createAccessVerifier(env.accessIdentity) : undefined;
  const sessionBound = verifier
    ? createAccessSessionBinding(verifier, {
        linkedSubject: async (userId) =>
          (
            await prisma.account.findFirst({
              where: { userId, providerId: ACCESS_PROVIDER_ID },
              select: { accountId: true },
            })
          )?.accountId,
        endSession: async (session) => {
          await prisma.session.deleteMany({ where: { id: session.id } });
          await pushTokens
            .endSession(session.userId, session.id)
            .catch((error) => getLogger().error("push token removal failed", error));
        },
      })
    : undefined;
  return {
    verifier,
    capabilities: verifier
      ? {
          accessIdentity: true,
          ...(env.accessIdentity?.logoutUrl
            ? { accessLogoutUrl: env.accessIdentity.logoutUrl }
            : {}),
        }
      : {},
    unready: verifier
      ? async () => ((await verifier.ready()) ? undefined : "access_identity_keys_unavailable")
      : undefined,
    mountGate(app) {
      if (verifier)
        app.use(
          "*",
          accessIdentityGate(verifier, { exemptWebhooks: env.accessExemptWebhooks ?? [] }),
        );
    },
    bindSession(read) {
      return async (request, ...rest) => {
        const session = await read(request, ...rest);
        if (!session?.user) return null;
        if (sessionBound && !(await sessionBound(request, session))) return null;
        return session;
      };
    },
    async beforeAuthHandler(request, getSession) {
      if (!sessionBound) return;
      const session = await getSession(request.headers);
      if (session?.user) await sessionBound(request, session);
    },
  };
}
