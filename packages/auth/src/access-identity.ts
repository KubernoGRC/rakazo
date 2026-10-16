import type { KeyObject } from "node:crypto";
import { createPublicKey, verify as verifySignature } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isMessagingEmail } from "@rakazo/core";
import type { BetterAuthPlugin, GenericEndpointContext } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";

/**
 * Fork: trusted access-proxy identity mode. The proxy in front of the origin
 * authenticates the user and forwards a signed RS256 assertion; this module
 * verifies it and is the only way an account or session is created in the
 * mode. See docs/fork-access-identity.md.
 */
export interface AccessIdentityConfig {
  /** The `iss` the assertion must carry, exactly. */
  issuer: string;
  /** A value the assertion's `aud` must contain. */
  audience: string;
  /** JWKS (or a `certs` document with a `keys` array) written by the host. */
  certsFile: string;
}

export const ACCESS_ASSERTION_HEADER = "cf-access-jwt-assertion";
export const ACCESS_SIGN_IN_PATH = "/access-identity/sign-in";
/** The `validateUserInfo` source method for accounts this module creates. */
export const ACCESS_IDENTITY_METHOD = "access-identity";
/** The Better Auth `account.providerId` that records an access identity link. */
export const ACCESS_PROVIDER_ID = "access-identity";
/** Tolerated clock difference for `exp` and `nbf`, in seconds. */
export const ACCESS_CLOCK_SKEW_SECONDS = 60;
/** How recent `iat` must be for an assertion to count as re-authentication. */
export const ACCESS_FRESH_AGE_SECONDS = 5 * 60;

export type AccessRefusal =
  | "missing"
  | "malformed"
  | "unsupported_algorithm"
  | "certs_unavailable"
  | "unknown_kid"
  | "bad_signature"
  | "wrong_issuer"
  | "wrong_audience"
  | "expired"
  | "not_yet_valid"
  | "no_email"
  | "no_subject";

export interface AccessIdentity {
  email: string;
  /** `iss` and `sub`: the stable identity, unlike the email, which can be reassigned. */
  subject: string;
  /** `iat` in seconds, when the access proxy authenticated the user. */
  issuedAt: number | undefined;
}

export type AccessVerdict = ({ ok: true } & AccessIdentity) | { ok: false; reason: AccessRefusal };

/** The stored link key: issuer and subject, which an access proxy never reuses together. */
export function accessSubjectKey(issuer: string, subject: string): string {
  return `${issuer} ${subject}`;
}

export interface AccessVerifier {
  verify(headers: Headers): Promise<AccessVerdict>;
  /** Whether a usable key set is loaded: until then every assertion is refused. */
  ready(): Promise<boolean>;
}

type KeySet = Map<string, KeyObject>;

/**
 * Loads signing keys from the certs file, reloading when its mtime or size
 * changes. A file that cannot be read or parsed, or that holds no usable key,
 * keeps the last good set; with no good set every assertion is refused.
 */
export function createAccessVerifier(
  config: AccessIdentityConfig,
  { now = () => Date.now() }: { now?: () => number } = {},
): AccessVerifier {
  let keys: KeySet | undefined;
  let loadedStamp: string | undefined;
  let loading: Promise<void> | undefined;

  async function refresh() {
    let stamp: string;
    try {
      const info = await stat(config.certsFile);
      stamp = `${info.mtimeMs}:${info.size}`;
    } catch {
      return;
    }
    if (stamp === loadedStamp) return;
    try {
      const parsed = parseKeySet(await readFile(config.certsFile, "utf8"));
      if (parsed.size === 0) return;
      keys = parsed;
      loadedStamp = stamp;
    } catch {
      // Keep the last good set; a half-written file is retried on the next request.
    }
  }

  async function currentKeys(): Promise<KeySet | undefined> {
    loading ??= refresh().finally(() => {
      loading = undefined;
    });
    await loading;
    return keys;
  }

  return {
    async ready() {
      return (await currentKeys()) !== undefined;
    },
    async verify(headers) {
      const token = headers.get(ACCESS_ASSERTION_HEADER)?.trim();
      if (!token) return refuse("missing");
      const parts = token.split(".");
      if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part)))
        return refuse("malformed");
      const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
      const header = decodeJson(encodedHeader);
      const payload = decodeJson(encodedPayload);
      if (!header || !payload) return refuse("malformed");
      if (header.alg !== "RS256") return refuse("unsupported_algorithm");
      if (typeof header.kid !== "string" || !header.kid) return refuse("unknown_kid");
      const keySet = await currentKeys();
      if (!keySet) return refuse("certs_unavailable");
      const key = keySet.get(header.kid);
      if (!key) return refuse("unknown_kid");
      const signed = verifySignature(
        "RSA-SHA256",
        Buffer.from(`${encodedHeader}.${encodedPayload}`),
        key,
        Buffer.from(encodedSignature, "base64url"),
      );
      if (!signed) return refuse("bad_signature");
      if (payload.iss !== config.issuer) return refuse("wrong_issuer");
      const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (!audience.includes(config.audience)) return refuse("wrong_audience");
      const seconds = now() / 1_000;
      if (typeof payload.exp !== "number" || seconds > payload.exp + ACCESS_CLOCK_SKEW_SECONDS)
        return refuse("expired");
      if (payload.nbf !== undefined) {
        if (typeof payload.nbf !== "number") return refuse("malformed");
        if (seconds + ACCESS_CLOCK_SKEW_SECONDS < payload.nbf) return refuse("not_yet_valid");
      }
      const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
      if (!email.includes("@")) return refuse("no_email");
      if (typeof payload.sub !== "string" || !payload.sub.trim()) return refuse("no_subject");
      if (payload.iat !== undefined && typeof payload.iat !== "number") return refuse("malformed");
      return {
        ok: true,
        email,
        subject: accessSubjectKey(config.issuer, payload.sub),
        issuedAt: payload.iat,
      };
    },
  };
}

function refuse(reason: AccessRefusal): AccessVerdict {
  return { ok: false, reason };
}

function decodeJson(part: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** RSA signing keys by `kid`. Keys for another use or algorithm are ignored. */
export function parseKeySet(text: string): KeySet {
  const document: unknown = JSON.parse(text);
  const entries =
    typeof document === "object" && document !== null && "keys" in document
      ? (document as { keys: unknown }).keys
      : undefined;
  const keys: KeySet = new Map();
  if (!Array.isArray(entries)) return keys;
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const jwk = entry as Record<string, unknown>;
    if (jwk.kty !== "RSA" || typeof jwk.kid !== "string" || !jwk.kid) continue;
    if (typeof jwk.n !== "string" || typeof jwk.e !== "string") continue;
    if (jwk.use !== undefined && jwk.use !== "sig") continue;
    if (jwk.alg !== undefined && jwk.alg !== "RS256") continue;
    try {
      keys.set(
        jwk.kid,
        createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" }),
      );
    } catch {
      // A malformed entry does not invalidate the others.
    }
  }
  return keys;
}

/**
 * Auth routes a verified access identity replaces. Every other way to sign in,
 * create an account, or change the email an account is bound to is closed.
 */
export function accessIdentityClosesPath(path: string): boolean {
  return (
    /^\/(sign-in|sign-up|callback|oauth2|link-social|magic-link|email-otp|one-tap|passkey|phone-number|sso)(\/|$)/.test(
      path,
    ) ||
    [
      "/request-password-reset",
      "/reset-password",
      "/change-password",
      "/set-password",
      "/change-email",
      "/unlink-account",
      "/verify-email",
      "/send-verification-email",
    ].includes(path)
  );
}

type Adapter = GenericEndpointContext["context"]["internalAdapter"];

/** The access subject an account is linked to, if any. */
export async function linkedAccessSubject(
  adapter: Pick<Adapter, "findAccounts">,
  userId: string,
): Promise<string | undefined> {
  const accounts = await adapter.findAccounts(userId);
  return accounts.find((account) => account.providerId === ACCESS_PROVIDER_ID)?.accountId;
}

function refused(code: string): APIError {
  return new APIError("FORBIDDEN", {
    code,
    message: "Sign in through your organisation's portal",
  });
}

/** A unique-constraint violation from the database, however the adapter surfaces it. */
function isUniqueViolation(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    if ((current as { code?: unknown }).code === "P2002") return true;
    if (/unique constraint/i.test(current.message)) return true;
  }
  return false;
}

/**
 * Finds the account for a verified identity by its linked subject. An account
 * that has none is linked by email exactly once; an account linked to another
 * subject is refused, never merged, so a reassigned email cannot inherit it.
 *
 * Overlapping first sign-ins are settled by the database, not a held lock: the
 * fork's migration makes an access-identity link unique per subject, and user
 * emails are unique. The request that loses an insert removes the user it just
 * created (it has no session or space yet) and resolves again, which finds the
 * winner's link.
 */
async function accountForIdentity(
  adapter: Adapter,
  identity: AccessIdentity,
  retried = false,
): ReturnType<typeof resolveAccount> {
  try {
    return await resolveAccount(adapter, identity);
  } catch (error) {
    if (retried || !(error instanceof LostInsert) || !isUniqueViolation(error.cause)) throw error;
    if (error.createdUserId) await adapter.deleteUser(error.createdUserId);
    return accountForIdentity(adapter, identity, true);
  }
}

class LostInsert extends Error {
  constructor(
    cause: unknown,
    readonly createdUserId?: string,
  ) {
    super("access identity insert lost a race", { cause });
  }
}

async function resolveAccount(adapter: Adapter, identity: AccessIdentity) {
  const linked = await adapter.findAccountByKey({
    providerId: ACCESS_PROVIDER_ID,
    accountId: identity.subject,
  });
  if (linked) {
    const user = await adapter.findUserById(linked.userId);
    if (!user) throw refused("ACCESS_IDENTITY_UNLINKED");
    if (user.email.toLowerCase() === identity.email) return { user, created: false };
    // The same subject under a new email: follow it, unless the email belongs to someone else.
    const holder = (await adapter.findUserByEmail(identity.email))?.user;
    if (holder && holder.id !== user.id) throw refused("ACCESS_IDENTITY_EMAIL_IN_USE");
    return {
      user: await adapter.updateUser(user.id, { email: identity.email, emailVerified: true }),
      created: false,
    };
  }
  let user = (await adapter.findUserByEmail(identity.email))?.user;
  const created = !user;
  if (user) {
    if (await linkedAccessSubject(adapter, user.id))
      throw refused("ACCESS_IDENTITY_SUBJECT_MISMATCH");
    if (!user.emailVerified) user = await adapter.updateUser(user.id, { emailVerified: true });
  } else {
    try {
      user = await adapter.createUser(
        {
          email: identity.email,
          name: identity.email.split("@")[0] || identity.email,
          emailVerified: true,
        },
        { method: ACCESS_IDENTITY_METHOD },
      );
    } catch (error) {
      throw new LostInsert(error);
    }
  }
  if (!user) throw new APIError("INTERNAL_SERVER_ERROR");
  let link: Awaited<ReturnType<Adapter["createAccount"]>>;
  try {
    link = await adapter.createAccount({
      userId: user.id,
      providerId: ACCESS_PROVIDER_ID,
      accountId: identity.subject,
    });
  } catch (error) {
    throw new LostInsert(error, created ? user.id : undefined);
  }
  // Backstop: an account carries at most one access-identity link.
  const links = (await adapter.findAccounts(user.id)).filter(
    (account) => account.providerId === ACCESS_PROVIDER_ID,
  );
  if (links.some((account) => account.accountId !== identity.subject)) {
    await adapter.deleteAccount(link.id);
    throw refused("ACCESS_IDENTITY_SUBJECT_MISMATCH");
  }
  return { user, created };
}

/**
 * The session bootstrap: verifies the assertion, finds the account linked to
 * its subject (or links or creates one), and issues a normal session cookie.
 */
export function accessIdentity(verifier: AccessVerifier): BetterAuthPlugin {
  return {
    id: "access-identity",
    endpoints: {
      accessIdentitySignIn: createAuthEndpoint(
        ACCESS_SIGN_IN_PATH,
        { method: "POST", requireHeaders: true },
        async (ctx) => {
          const verdict = await verifier.verify(ctx.headers ?? new Headers());
          if (!verdict.ok)
            throw new APIError("UNAUTHORIZED", {
              code: "ACCESS_IDENTITY_REQUIRED",
              message: "Sign in through your organisation's portal",
            });
          if (isMessagingEmail(verdict.email))
            throw new APIError("FORBIDDEN", { message: "Email is not available" });
          const adapter = ctx.context.internalAdapter;
          const { user, created } = await accountForIdentity(adapter, verdict);
          const session = await adapter.createSession(user.id);
          if (!session) throw new APIError("INTERNAL_SERVER_ERROR");
          await setSessionCookie(ctx, { session, user });
          return ctx.json({
            created,
            user: { id: user.id, email: user.email, name: user.name },
          });
        },
      ),
    },
  };
}

/**
 * Re-authentication for sensitive actions such as account deletion: the
 * request carries an assertion for the account's own linked subject, issued
 * within the freshness window.
 */
export function accessReauthentication(
  verifier: AccessVerifier,
  { now = () => Date.now() }: { now?: () => number } = {},
) {
  return async (ctx: GenericEndpointContext, userId: string): Promise<boolean> => {
    const verdict = await verifier.verify(ctx.headers ?? new Headers());
    if (!verdict.ok || verdict.issuedAt === undefined) return false;
    const age = now() / 1_000 - verdict.issuedAt;
    if (age > ACCESS_FRESH_AGE_SECONDS || age < -ACCESS_CLOCK_SKEW_SECONDS) return false;
    return (await linkedAccessSubject(ctx.context.internalAdapter, userId)) === verdict.subject;
  };
}
