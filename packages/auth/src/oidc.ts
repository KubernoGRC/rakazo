import { createHash } from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";
import { APIError } from "better-auth/api";
import { genericOAuth } from "better-auth/plugins";

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  name: string;
  scopes: string[];
  allowSignupBypass: boolean;
  /**
   * Fork: the group every OIDC sign-in must carry in the ID token's `groups`
   * claim. Unset keeps upstream behaviour. See docs/fork-oidc-group-gate.md.
   */
  requiredGroup?: string;
}

/** Discovery never gates API startup. Failed attempts share exponential backoff. */
export function oidcDiscovery(config: OidcConfig) {
  const generic = genericOAuth({
    config: [
      {
        providerId: "oidc",
        name: config.name,
        discoveryUrl: `${config.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        scopes: [...new Set(["openid", "email", "profile", ...config.scopes])],
        pkce: true,
        accountSubject: ({ profile }) => {
          if (typeof profile.sub !== "string" || !profile.sub.trim()) return "";
          // Subjects are unique within an issuer, never across different IdPs.
          return oidcAccountSubject(config.issuer, profile.sub);
        },
        requireIdTokenVerification: true,
        // Every round-trip can serve as fresh authentication for account deletion.
        prompt: "login",
        authorizationUrlParams: { max_age: "0" },
        mapProfileToUser: (profile) => ({ emailVerified: profile.email_verified === true }),
        // The group gate reads the verified ID token and nothing else: the
        // default falls back to the userinfo endpoint, which carries no groups.
        ...(config.requiredGroup ? { getUserInfo: idTokenProfile } : {}),
      },
    ],
  });
  type Provider = Awaited<ReturnType<typeof generic.init>>["context"]["socialProviders"][number];
  let provider: Provider | undefined;
  let pending: Promise<Provider> | undefined;
  let nextAttempt = 0;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let availability: "checking" | "available" | "unavailable" = "checking";
  const unavailable = () =>
    new APIError("SERVICE_UNAVAILABLE", {
      code: "SSO_UNAVAILABLE",
      message: "SSO is temporarily unavailable. Try again.",
    });
  const plugin: BetterAuthPlugin = {
    id: "oidc-discovery",
    init(ctx) {
      const schedule = (delay: number) => {
        if (disposed) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          void discover().catch(() => undefined);
        }, delay);
        timer.unref?.();
      };
      const discover = (): Promise<Provider> => {
        if (pending) return pending;
        if (Date.now() < nextAttempt) return Promise.reject(unavailable());
        pending = (async () => {
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            const result = await Promise.race([
              // The library may log upstream error detail. Keep discovery errors generic.
              generic.init({
                ...ctx,
                socialProviders: ctx.socialProviders.filter((item) => item.id !== "oidc"),
                logger: { ...ctx.logger, error: () => undefined },
              }),
              new Promise<never>((_, reject) => {
                timeout = setTimeout(() => reject(unavailable()), 8_000);
              }),
            ]);
            const discovered = result.context.socialProviders[0];
            if (
              !discovered ||
              typeof discovered === "function" ||
              discovered.issuer !== config.issuer
            )
              throw unavailable();
            provider = discovered;
            availability = "available";
            failures = 0;
            nextAttempt = 0;
            schedule(5 * 60_000);
            return discovered;
          } catch {
            provider = undefined;
            availability = "unavailable";
            const delay = Math.min(60_000, 1_000 * 2 ** Math.min(failures++, 6));
            nextAttempt = Date.now() + delay;
            schedule(delay);
            throw unavailable();
          } finally {
            clearTimeout(timeout);
            pending = undefined;
          }
        })();
        return pending;
      };
      schedule(0);
      const getProvider = () => (provider ? Promise.resolve(provider) : discover());
      const lazy: Provider = {
        id: "oidc",
        name: config.name,
        issuer: config.issuer,
        requiresIdTokenNonce: true,
        createAuthorizationURL: async (data) => (await getProvider()).createAuthorizationURL(data),
        validateAuthorizationCode: async (data) =>
          (await getProvider()).validateAuthorizationCode(data),
        getUserInfo: async (tokens) =>
          tokens.idToken ? (await getProvider()).getUserInfo(tokens) : null,
        accountSubject: async (data) => {
          const resolved = await getProvider();
          if (!resolved.accountSubject) throw unavailable();
          return resolved.accountSubject(data);
        },
        refreshAccessToken: async (token, context) => {
          const resolved = await getProvider();
          if (!resolved.refreshAccessToken) throw unavailable();
          return resolved.refreshAccessToken(token, context);
        },
      };
      return { context: { socialProviders: [lazy, ...ctx.socialProviders] } };
    },
  };
  return {
    plugin,
    availability: () => availability,
    dispose: () => {
      disposed = true;
      clearTimeout(timer);
    },
  };
}

export function oidcAccountSubject(issuer: string, subject: string) {
  return createHash("sha256")
    .update(JSON.stringify([issuer, subject]))
    .digest("hex");
}

/** Stored ID tokens were verified during linking; bind their subject to the stored account ID. */
export function isCurrentOidcAccount(
  account: { providerId: string; accountId: string; idToken?: string | null },
  issuer: string | undefined,
) {
  if (!issuer || account.providerId !== "oidc" || !account.idToken) return false;
  try {
    const claims = JSON.parse(
      Buffer.from(account.idToken.split(".")[1] ?? "", "base64url").toString(),
    );
    return (
      claims.iss === issuer &&
      typeof claims.sub === "string" &&
      account.accountId === oidcAccountSubject(issuer, claims.sub)
    );
  } catch {
    return false;
  }
}

/**
 * Fork: the profile is the ID token's own claims, which the generic provider has
 * already verified (signature, issuer, audience, nonce) before calling this.
 */
async function idTokenProfile(tokens: { idToken?: string }) {
  if (!tokens.idToken) return null;
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(
      Buffer.from(tokens.idToken.split(".")[1] ?? "", "base64url").toString(),
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!claims || typeof claims !== "object" || typeof claims.sub !== "string" || !claims.sub)
    return null;
  return {
    ...claims,
    id: claims.sub,
    email: typeof claims.email === "string" ? claims.email : "",
    emailVerified: claims.email_verified === true,
    name: typeof claims.name === "string" ? claims.name : "",
    image: typeof claims.picture === "string" ? claims.picture : undefined,
  };
}

/**
 * Fork: why an OIDC profile may not sign in under the group gate, or undefined
 * when it carries `group` in its `groups` claim. A token that reports a group
 * overage (`_claim_names.groups`, or `hasgroups`) names no groups and is
 * refused: resolving it would need Microsoft Graph, which this gate never calls.
 */
export function oidcGroupRefusal(profile: unknown, group: string): string | undefined {
  if (!profile || typeof profile !== "object") return "GROUP_CLAIM_MISSING";
  const claims = profile as Record<string, unknown>;
  const claimNames = claims._claim_names;
  if (
    claims.hasgroups === true ||
    claims.hasgroups === "true" ||
    (claimNames && typeof claimNames === "object" && "groups" in claimNames)
  )
    return "GROUP_CLAIM_OVERAGE";
  const groups = claims.groups;
  if (!Array.isArray(groups)) return "GROUP_CLAIM_MISSING";
  return groups.some((value) => value === group) ? undefined : "GROUP_NOT_ALLOWED";
}
