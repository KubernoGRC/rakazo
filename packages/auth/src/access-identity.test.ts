import type { KeyObject } from "node:crypto";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapUserSpace } from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessIdentityConfig, AccessVerifier } from "./access-identity.js";
import {
  ACCESS_ASSERTION_HEADER,
  accessIdentityClosesPath,
  createAccessVerifier,
} from "./access-identity.js";
import { assertAccessIdentityConfig, createAuth } from "./index.js";

vi.mock("better-auth/adapters/prisma", async () => {
  const { memoryAdapter } = await import("better-auth/adapters/memory");
  return {
    prismaAdapter: (prisma: { authData: Record<string, unknown[]> }) =>
      memoryAdapter(prisma.authData),
  };
});
vi.mock("@rakazo/db", () => ({ bootstrapUserSpace: vi.fn(async () => ({ spaceId: "space-1" })) }));

const ISSUER = "https://team.access.example.test";
const AUDIENCE = "app-audience";
const NOW = 1_800_000_000_000;

function keyPair() {
  return generateKeyPairSync("rsa", { modulusLength: 2048 });
}

const signing = keyPair();
const other = keyPair();

function jwk(publicKey: KeyObject, kid: string) {
  return { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
}

function certsFile(keys: unknown[]) {
  const path = join(mkdtempSync(join(tmpdir(), "access-certs-")), "certs.json");
  writeFileSync(path, JSON.stringify({ keys, public_cert: { kid: "ignored", cert: "x" } }));
  return path;
}

function b64(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function token(
  claims: Record<string, unknown> = {},
  { kid = "k1", key = signing.privateKey, alg = "RS256" } = {},
) {
  const header = b64({ alg, kid, typ: "JWT" });
  const payload = b64({
    iss: ISSUER,
    aud: [AUDIENCE],
    email: "Person@Example.test",
    exp: NOW / 1_000 + 300,
    nbf: NOW / 1_000 - 10,
    iat: NOW / 1_000 - 10,
    sub: "subject-1",
    ...claims,
  });
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), key);
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

function verifierFor(path: string, overrides: Partial<AccessIdentityConfig> = {}) {
  return createAccessVerifier(
    { issuer: ISSUER, audience: AUDIENCE, certsFile: path, ...overrides },
    { now: () => NOW },
  );
}

const headers = (value?: string) =>
  new Headers(value === undefined ? {} : { [ACCESS_ASSERTION_HEADER]: value });

describe("access assertion verification", () => {
  const path = certsFile([jwk(signing.publicKey, "k1")]);
  const verifier = verifierFor(path);

  it("accepts a valid assertion and returns its email, lower-cased", async () => {
    expect(await verifier.verify(headers(token()))).toEqual({
      ok: true,
      email: "person@example.test",
      subject: `${ISSUER} subject-1`,
      issuedAt: NOW / 1_000 - 10,
    });
  });

  it("accepts an audience given as a string", async () => {
    expect(await verifier.verify(headers(token({ aud: AUDIENCE })))).toMatchObject({ ok: true });
  });

  it.each([
    ["missing", undefined],
    ["missing", ""],
    ["malformed", "not-a-jwt"],
    ["malformed", "a.b.c.d"],
  ])("refuses %s for %j", async (reason, value) => {
    expect(await verifier.verify(headers(value))).toEqual({ ok: false, reason });
  });

  it.each([
    ["wrong_audience", { aud: ["another-app"] }],
    ["wrong_audience", { aud: undefined }],
    ["wrong_issuer", { iss: "https://elsewhere.example.test" }],
    ["wrong_issuer", { iss: `${ISSUER}/` }],
    ["expired", { exp: NOW / 1_000 - 61 }],
    ["expired", { exp: undefined }],
    ["not_yet_valid", { nbf: NOW / 1_000 + 61 }],
    ["no_email", { email: undefined }],
    ["no_email", { email: "" }],
    ["no_email", { email: "service-token" }],
    ["no_subject", { sub: undefined }],
    ["no_subject", { sub: "" }],
    ["malformed", { iat: "yesterday" }],
  ])("refuses %s", async (reason, claims) => {
    expect(await verifier.verify(headers(token(claims)))).toEqual({ ok: false, reason });
  });

  it("tolerates small clock skew on exp and nbf", async () => {
    expect(
      await verifier.verify(headers(token({ exp: NOW / 1_000 - 30, nbf: NOW / 1_000 + 30 }))),
    ).toMatchObject({ ok: true });
  });

  it("refuses a bad signature under a known kid", async () => {
    expect(await verifier.verify(headers(token({}, { key: other.privateKey })))).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("refuses a tampered payload", async () => {
    const [h, , s] = token().split(".");
    const forged = `${h}.${b64({ iss: ISSUER, aud: AUDIENCE, email: "boss@example.test", exp: NOW / 1_000 + 300 })}.${s}`;
    expect(await verifier.verify(headers(forged))).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses an unknown kid", async () => {
    expect(await verifier.verify(headers(token({}, { kid: "k9" })))).toEqual({
      ok: false,
      reason: "unknown_kid",
    });
  });

  it("refuses any algorithm but RS256", async () => {
    for (const alg of ["none", "HS256", "RS512"]) {
      expect(await verifier.verify(headers(token({}, { alg })))).toEqual({
        ok: false,
        reason: "unsupported_algorithm",
      });
    }
  });

  it("ignores an unverified email header", async () => {
    expect(
      await verifier.verify(
        new Headers({
          "cf-access-authenticated-user-email": "person@example.test",
          "x-forwarded-email": "person@example.test",
        }),
      ),
    ).toEqual({ ok: false, reason: "missing" });
  });
});

describe("access certs file", () => {
  it.each([
    ["absent", () => "/nonexistent/certs.json"],
    [
      "malformed",
      () => {
        const path = certsFile([]);
        writeFileSync(path, "{ not json");
        return path;
      },
    ],
    ["without a usable key", () => certsFile([{ kty: "EC", kid: "k1" }])],
  ])("is not ready while the certs file is %s", async (_label, path) => {
    expect(await verifierFor(path()).ready()).toBe(false);
  });

  it("becomes ready once a usable key loads and stays ready on the last good set", async () => {
    const path = certsFile([{ kty: "EC", kid: "k1" }]);
    const verifier = verifierFor(path);
    expect(await verifier.ready()).toBe(false);
    writeFileSync(path, JSON.stringify({ keys: [jwk(signing.publicKey, "k1")] }));
    expect(await verifier.ready()).toBe(true);
    writeFileSync(path, "{ not json");
    expect(await verifier.ready()).toBe(true);
  });

  it("fails closed when the file has never been readable", async () => {
    const verifier = verifierFor("/nonexistent/certs.json");
    expect(await verifier.verify(headers(token()))).toEqual({
      ok: false,
      reason: "certs_unavailable",
    });
  });

  it("fails closed when the file holds no usable key", async () => {
    const verifier = verifierFor(certsFile([{ kty: "EC", kid: "k1" }]));
    expect(await verifier.verify(headers(token()))).toEqual({
      ok: false,
      reason: "certs_unavailable",
    });
  });

  it("reloads on change and keeps the last good set when the file breaks", async () => {
    const path = certsFile([jwk(signing.publicKey, "k1")]);
    const verifier = verifierFor(path);
    expect(await verifier.verify(headers(token()))).toMatchObject({ ok: true });

    // Rotation: the old key is gone, a new one is published.
    writeFileSync(path, JSON.stringify({ keys: [jwk(other.publicKey, "k2"), {}] }));
    expect(await verifier.verify(headers(token()))).toEqual({ ok: false, reason: "unknown_kid" });
    expect(
      await verifier.verify(headers(token({}, { kid: "k2", key: other.privateKey }))),
    ).toMatchObject({ ok: true });

    // A half-written file keeps the last good set.
    writeFileSync(path, "{ not json");
    expect(
      await verifier.verify(headers(token({}, { kid: "k2", key: other.privateKey }))),
    ).toMatchObject({ ok: true });
  });
});

describe("accessIdentityClosesPath", () => {
  it.each([
    "/sign-in/email",
    "/sign-in/social",
    "/sign-in/magic-link",
    "/sign-up/email",
    "/callback/oidc",
    "/oauth2/callback/oidc",
    "/link-social",
    "/magic-link/verify",
    "/email-otp/send-verification-otp",
    "/request-password-reset",
    "/reset-password",
    "/change-password",
    "/set-password",
    "/change-email",
    "/verify-email",
    "/unlink-account",
  ])("closes %s", (path) => {
    expect(accessIdentityClosesPath(path)).toBe(true);
  });

  it.each(["/get-session", "/sign-out", "/access-identity/sign-in", "/list-sessions"])(
    "keeps %s",
    (path) => {
      expect(accessIdentityClosesPath(path)).toBe(false);
    },
  );
});

describe("access identity startup checks", () => {
  const verifier: AccessVerifier = {
    verify: async () => ({ ok: false, reason: "missing" }),
    ready: async () => false,
  };

  it("requires password auth to be off", () => {
    expect(() => assertAccessIdentityConfig({ accessIdentity: verifier })).toThrow(/password/);
    expect(() =>
      assertAccessIdentityConfig({ accessIdentity: verifier, passwordAuth: true }),
    ).toThrow(/password/);
  });

  it("refuses OIDC beside it", () => {
    expect(() =>
      assertAccessIdentityConfig({
        accessIdentity: verifier,
        passwordAuth: false,
        oidc: {
          issuer: "https://idp.example.test",
          clientId: "c",
          clientSecret: "s",
          name: "SSO",
          scopes: ["openid"],
          allowSignupBypass: false,
        },
      }),
    ).toThrow(/OIDC/);
  });

  it("allows access identity as the only way in", () => {
    expect(() =>
      assertAccessIdentityConfig({ accessIdentity: verifier, passwordAuth: false }),
    ).not.toThrow();
  });
});

function fixture() {
  const data: Record<string, Record<string, unknown>[]> = {
    user: [],
    account: [],
    session: [],
    verification: [],
  };
  const members = new Set<string>();
  // A closed signup policy: a verified access identity must still get in.
  const policy = {
    signupsEnabled: false,
    signupAllowlist: "someone-else@example.test",
    signupPolicyInitialized: true,
    ownerUserId: null,
  };
  const prisma = {
    authData: data,
    $executeRaw: vi.fn(async () => 0),
    $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(prisma)),
    deploymentSettings: {
      findUnique: vi.fn(async () => policy),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    member: { findMany: vi.fn(async () => []) },
    messagingIdentity: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    organization: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    spaceMember: {
      findFirst: vi.fn(async ({ where }: { where: { userId: string } }) =>
        members.has(where.userId) ? { spaceId: "space-1" } : null,
      ),
    },
  };
  vi.mocked(bootstrapUserSpace).mockImplementation(async (_prisma, user) => {
    members.add(user.id);
    return { spaceId: "space-1" };
  });
  const baseURL = "http://auth.example.test";
  const webOrigin = "http://web.example.test";
  const auth = createAuth(prisma as never, {
    passwordAuth: false,
    accessIdentity: verifierFor(certsFile([jwk(signing.publicKey, "k1")])),
    secret: "offline-auth-secret-at-least-32-characters",
    baseURL,
    webOrigin,
    signupsEnabled: "false",
    signupAllowlist: "",
  });
  const request = (
    path: string,
    { assertion, cookie, body }: { assertion?: string; cookie?: string; body?: unknown } = {},
  ) =>
    auth.handler(
      new Request(`${baseURL}/api/auth${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "content-type": "application/json",
          origin: webOrigin,
          ...(assertion ? { [ACCESS_ASSERTION_HEADER]: assertion } : {}),
          ...(cookie ? { cookie } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  return { auth, request, data, members, prisma };
}

function sessionCookie(response: Response) {
  const header = response.headers.get("set-cookie") ?? "";
  const match = header.match(/(better-auth\.session_token=[^;]+)/);
  return match?.[1];
}

beforeEach(() => vi.clearAllMocks());

describe("access identity sign-in", () => {
  it("creates the user on first sign-in and issues a session", async () => {
    const f = fixture();
    const response = await f.request("/access-identity/sign-in", {
      assertion: token(),
      body: {},
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      created: true,
      user: { email: "person@example.test" },
    });
    expect(f.data.user).toHaveLength(1);
    expect(f.data.user?.[0]).toMatchObject({ email: "person@example.test", emailVerified: true });
    expect(bootstrapUserSpace).toHaveBeenCalledTimes(1);

    const cookie = sessionCookie(response);
    expect(cookie).toBeTruthy();
    const session = await f.request("/get-session", { cookie, assertion: token() });
    expect(await session.json()).toMatchObject({ user: { email: "person@example.test" } });
  });

  it("signs an existing user in without creating another", async () => {
    const f = fixture();
    await f.request("/access-identity/sign-in", { assertion: token(), body: {} });
    const again = await f.request("/access-identity/sign-in", { assertion: token(), body: {} });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ created: false });
    expect(f.data.user).toHaveLength(1);
    expect(f.data.session).toHaveLength(2);
  });

  it.each([
    ["no assertion", undefined],
    ["a wrong audience", token({ aud: "another-app" })],
    ["a wrong issuer", token({ iss: "https://elsewhere.example.test" })],
    ["an expired assertion", token({ exp: NOW / 1_000 - 3_600 })],
    ["a bad signature", token({}, { key: other.privateKey })],
    ["an unknown kid", token({}, { kid: "k9" })],
  ])("refuses %s and creates nothing", async (_label, assertion) => {
    const f = fixture();
    const response = await f.request("/access-identity/sign-in", { assertion, body: {} });
    expect(response.status).toBe(401);
    expect(f.data.user).toHaveLength(0);
    expect(f.data.session).toHaveLength(0);
  });

  it("refuses an email header that is not a signed assertion", async () => {
    const f = fixture();
    const response = await f.auth.handler(
      new Request("http://auth.example.test/api/auth/access-identity/sign-in", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://web.example.test",
          "cf-access-authenticated-user-email": "person@example.test",
        },
        body: "{}",
      }),
    );
    expect(response.status).toBe(401);
    expect(f.data.user).toHaveLength(0);
  });

  it("closes password and social sign-in and sign-up", async () => {
    const f = fixture();
    for (const [path, body] of [
      ["/sign-up/email", { email: "a@example.test", password: "offline-password12", name: "A" }],
      ["/sign-in/email", { email: "a@example.test", password: "offline-password12" }],
      ["/sign-in/social", { provider: "oidc" }],
    ] as const) {
      const response = await f.request(path, { assertion: token(), body });
      expect(response.status, path).toBe(403);
    }
    expect(f.data.user).toHaveLength(0);
  });
});

const signIn = (f: ReturnType<typeof fixture>, assertion: string) =>
  f.request("/access-identity/sign-in", { assertion, body: {} });

const accessLinks = (f: ReturnType<typeof fixture>) =>
  (f.data.account ?? []).filter((account) => account.providerId === "access-identity");

describe("access identity subject binding", () => {
  it("links the issuer and subject on first sign-in", async () => {
    const f = fixture();
    expect((await signIn(f, token())).status).toBe(200);
    expect(accessLinks(f)).toEqual([
      expect.objectContaining({
        userId: f.data.user?.[0]?.id,
        accountId: `${ISSUER} subject-1`,
      }),
    ]);
  });

  it("serializes overlapping first sign-ins for one subject into one user and one link", async () => {
    const f = fixture();
    // A stand-in for the advisory locks: one transaction at a time.
    let tail: Promise<unknown> = Promise.resolve();
    f.prisma.$transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) => {
      const turn = tail.then(() => run(f.prisma));
      tail = turn.catch(() => undefined);
      return turn;
    });
    const [first, second] = await Promise.all([
      signIn(f, token({ email: "old@example.test" })),
      signIn(f, token({ email: "new@example.test" })),
    ]);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(f.data.user).toHaveLength(1);
    expect(accessLinks(f)).toHaveLength(1);
    const locks = f.prisma.$executeRaw.mock.calls.map((call) => call.slice(1).join(" "));
    expect(locks).toEqual(
      expect.arrayContaining([
        `access-identity email old@example.test`,
        `access-identity subject ${ISSUER} subject-1`,
      ]),
    );
  });

  it("links an existing unlinked account by email exactly once", async () => {
    const f = fixture();
    f.data.user?.push({
      id: "existing",
      email: "person@example.test",
      name: "Person",
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const first = await signIn(f, token());
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ created: false, user: { id: "existing" } });
    expect(accessLinks(f)).toHaveLength(1);
    expect(f.data.user?.[0]).toMatchObject({ emailVerified: true });

    // Once linked, another subject with the same email cannot take it over.
    const other = await signIn(f, token({ sub: "subject-2" }));
    expect(other.status).toBe(403);
    expect(await other.json()).toMatchObject({ code: "ACCESS_IDENTITY_SUBJECT_MISMATCH" });
    expect(accessLinks(f)).toHaveLength(1);
  });

  it("refuses a reassigned email instead of merging it into the old account", async () => {
    const f = fixture();
    await signIn(f, token());
    const sessions = f.data.session?.length;
    const reassigned = await signIn(f, token({ sub: "new-holder" }));
    expect(reassigned.status).toBe(403);
    expect(await reassigned.json()).toMatchObject({ code: "ACCESS_IDENTITY_SUBJECT_MISMATCH" });
    expect(f.data.user).toHaveLength(1);
    expect(f.data.session?.length).toBe(sessions);
  });

  it("follows the same subject to a changed email", async () => {
    const f = fixture();
    await signIn(f, token());
    const renamed = await signIn(f, token({ email: "Person.Renamed@example.test" }));
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({
      created: false,
      user: { email: "person.renamed@example.test" },
    });
    expect(f.data.user).toHaveLength(1);
    expect(f.data.user?.[0]).toMatchObject({ email: "person.renamed@example.test" });
  });

  it("refuses a changed email that belongs to another account", async () => {
    const f = fixture();
    await signIn(f, token());
    await signIn(f, token({ sub: "subject-2", email: "colleague@example.test" }));
    const clash = await signIn(f, token({ email: "colleague@example.test" }));
    expect(clash.status).toBe(403);
    expect(await clash.json()).toMatchObject({ code: "ACCESS_IDENTITY_EMAIL_IN_USE" });
    expect(f.data.user?.map((user) => user.email).sort()).toEqual([
      "colleague@example.test",
      "person@example.test",
    ]);
  });
});

describe("access identity re-authentication for account deletion", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  async function signedIn() {
    const f = fixture();
    const cookie = sessionCookie(await signIn(f, token()));
    return { f, cookie };
  }

  it("reports fresh re-authentication and deletes with a fresh matching assertion", async () => {
    const { f, cookie } = await signedIn();
    const security = await f.request("/account-security", { cookie, assertion: token() });
    expect(await security.json()).toMatchObject({ freshOidcAuth: true });
    const deleted = await f.request("/delete-user", { cookie, assertion: token(), body: {} });
    expect(deleted.status).toBe(200);
    expect(f.data.user).toHaveLength(0);
  });

  it.each([
    ["no assertion", undefined],
    ["a stale assertion", () => token({ iat: NOW / 1_000 - 6 * 60 })],
    ["an assertion with no iat", () => token({ iat: undefined })],
    ["another subject", () => token({ sub: "subject-2" })],
  ])("refuses deletion with %s", async (_label, make) => {
    const { f, cookie } = await signedIn();
    const assertion = make?.();
    const security = await f.request("/account-security", { cookie, assertion });
    expect(await security.json()).toMatchObject({ freshOidcAuth: false });
    const deleted = await f.request("/delete-user", { cookie, assertion, body: {} });
    expect(deleted.status).toBe(403);
    expect(f.data.user).toHaveLength(1);
  });
});
