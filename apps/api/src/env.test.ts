import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

const base = {
  DATABASE_URL: "postgres://rakazo:rakazo@127.0.0.1:5433/rakazo",
  NODE_ENV: "test",
};

describe("loadEnv", () => {
  it("keeps the ticket board off unless explicitly enabled", () => {
    expect(loadEnv(base).ticketBoardEnabled).toBe(false);
    for (const value of ["false", "1", ""])
      expect(loadEnv({ ...base, TICKET_BOARD_ENABLED: value }).ticketBoardEnabled).toBe(false);
    expect(loadEnv({ ...base, TICKET_BOARD_ENABLED: "true" }).ticketBoardEnabled).toBe(true);
  });
  it("defaults the product path to Pi, Docker, and Graphile Worker", () => {
    const env = loadEnv(base);
    expect(env.agentRuntime).toBe("pi");
    expect(env.sandboxProvider).toBe("docker");
    expect(env.wakeupDriver).toBe("graphile");
    expect(env.apiHost).toBe("127.0.0.1");
    expect(env.nodeEnv).toBe("test");
  });

  it("defaults Pi JSONL session recording to off", () => {
    expect(loadEnv(base).piSessionRecording).toBe(false);
    expect(loadEnv({ ...base, PI_SESSION_RECORDING: "false" }).piSessionRecording).toBe(false);
    expect(loadEnv({ ...base, PI_SESSION_RECORDING: "1" }).piSessionRecording).toBe(false);
    expect(loadEnv({ ...base, PI_SESSION_RECORDING: "true" }).piSessionRecording).toBe(true);
  });

  it("keeps explicit emulator settings for pnpm test", () => {
    const env = loadEnv({
      ...base,
      AGENT_RUNTIME: "scripted",
      SANDBOX_PROVIDER: "fake",
      WAKEUP_DRIVER: "memory",
    });
    expect(env.agentRuntime).toBe("scripted");
    expect(env.sandboxProvider).toBe("fake");
    expect(env.wakeupDriver).toBe("memory");
  });

  it("loads an optional integrations catalog mirror", () => {
    expect(loadEnv(base).integrationsCatalogUrl).toBeUndefined();
    expect(
      loadEnv({ ...base, INTEGRATIONS_CATALOG_URL: " https://catalog.example.test/feed " })
        .integrationsCatalogUrl,
    ).toBe("https://catalog.example.test/feed");
  });

  it("falls back to none when a remote provider key is missing", () => {
    expect(
      loadEnv({
        ...base,
        SANDBOX_PROVIDER: "e2b",
      }).sandboxProvider,
    ).toBe("none");
    expect(
      loadEnv({
        ...base,
        SANDBOX_PROVIDER: "createos",
      }).sandboxProvider,
    ).toBe("none");
    expect(
      loadEnv({
        ...base,
        SANDBOX_PROVIDER: "none",
      }).sandboxProvider,
    ).toBe("none");
    expect(
      loadEnv({
        ...base,
        SANDBOX_PROVIDER: "",
      }).sandboxProvider,
    ).toBe("none");
  });

  it("loads provider-specific Daytona configuration", () => {
    const env = loadEnv({
      ...base,
      SANDBOX_PROVIDER: "daytona",
      DAYTONA_API_KEY: "test-daytona-key",
      DAYTONA_API_URL: "https://daytona.test/api",
      DAYTONA_TARGET: "test-target",
    });
    expect(env).toMatchObject({
      sandboxProvider: "daytona",
      daytonaApiKey: "test-daytona-key",
      daytonaApiUrl: "https://daytona.test/api",
      daytonaTarget: "test-target",
    });
  });

  it("loads provider-specific Box configuration", () => {
    const env = loadEnv({
      ...base,
      SANDBOX_PROVIDER: "box",
      BOX_API_KEY: "test-box-key",
      BOX_API_URL: "https://box.test/api/v1",
    });
    expect(env).toMatchObject({
      sandboxProvider: "box",
      boxApiKey: "test-box-key",
      boxApiUrl: "https://box.test/api/v1",
    });
  });

  it("throws when production omits secrets", () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: base.DATABASE_URL,
        NODE_ENV: "production",
      }),
    ).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("throws when production uses placeholder secrets", () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: base.DATABASE_URL,
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "dev-secret-change-me-please-32chars",
        ENCRYPTION_KEY: "real-encryption-key-value",
        SANDBOX_SUPERVISOR_TOKEN: "real-supervisor-token-with-enough-length",
        SCREEN_PROXY_SECRET: "real-screen-proxy-secret-with-enough-length",
      }),
    ).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("loads real secrets in production", () => {
    const env = loadEnv({
      DATABASE_URL: base.DATABASE_URL,
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: "prod-auth-secret-with-enough-length",
      ENCRYPTION_KEY: "prod-encryption-key-with-enough-length",
      SCREEN_PROXY_SECRET: "prod-screen-proxy-secret-with-enough-length",
      SANDBOX_PROVIDER: "e2b",
      API_HOST: "0.0.0.0",
    });
    expect(env.authSecret).toBe("prod-auth-secret-with-enough-length");
    expect(env.encryptionKey).toBe("prod-encryption-key-with-enough-length");
    expect(env.sandboxSupervisorToken).toBeUndefined();
    expect(env.screenProxySecret).toBe("prod-screen-proxy-secret-with-enough-length");
    expect(env.apiHost).toBe("0.0.0.0");
  });

  it("falls back to none in production when Docker has no supervisor token", () => {
    const env = loadEnv({
      DATABASE_URL: base.DATABASE_URL,
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: "prod-auth-secret-with-enough-length",
      ENCRYPTION_KEY: "prod-encryption-key-with-enough-length",
      SCREEN_PROXY_SECRET: "prod-screen-proxy-secret-with-enough-length",
      SANDBOX_PROVIDER: "docker",
    });
    expect(env.sandboxProvider).toBe("none");
    expect(env.sandboxSupervisorToken).toBeUndefined();
  });

  it("requires a dedicated supervisor token when Docker stays selected", () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: base.DATABASE_URL,
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "prod-auth-secret-with-enough-length",
        ENCRYPTION_KEY: "prod-encryption-key-with-enough-length",
        SCREEN_PROXY_SECRET: "prod-screen-proxy-secret-with-enough-length",
        SANDBOX_PROVIDER: "docker",
        SANDBOX_SUPERVISOR_TOKEN: "too-short",
      }),
    ).toThrow(/SANDBOX_SUPERVISOR_TOKEN/);
  });

  it("exposes a deployed git revision when GIT_SHA is set", () => {
    expect(loadEnv(base).gitSha).toBeUndefined();
    expect(loadEnv({ ...base, GIT_SHA: "  3c6e209  " }).gitSha).toBe("3c6e209");
    expect(loadEnv({ ...base, RAKAZO_GIT_SHA: "abc1234" }).gitSha).toBe("abc1234");
  });

  it("loads optional updater sidecar wiring without requiring the token at boot", () => {
    expect(loadEnv(base).updaterUrl).toBeUndefined();
    expect(loadEnv(base).updaterToken).toBeUndefined();
    const env = loadEnv({
      ...base,
      RAKAZO_UPDATER_URL: " http://updater:7092 ",
      RAKAZO_UPDATER_TOKEN: " fake-review-updater-token-000000000000 ",
    });
    expect(env.updaterUrl).toBe("http://updater:7092");
    expect(env.updaterToken).toBe("fake-review-updater-token-000000000000");
  });

  it("loads SMTP configuration and keeps the email emulator out of production", () => {
    expect(
      loadEnv({
        ...base,
        SMTP_URL: " smtps://user:secret@smtp.example.test:465 ",
        EMAIL_FROM: " Rakazo <no-reply@example.test> ",
        EMAIL_EMULATOR: "true",
      }),
    ).toMatchObject({
      smtpUrl: "smtps://user:secret@smtp.example.test:465",
      emailFrom: "Rakazo <no-reply@example.test>",
      emailEmulator: true,
    });
    expect(
      loadEnv({
        ...base,
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "prod-auth-secret-with-enough-length",
        ENCRYPTION_KEY: "prod-encryption-key-with-enough-length",
        SCREEN_PROXY_SECRET: "prod-screen-proxy-secret-with-enough-length",
        SANDBOX_PROVIDER: "none",
        EMAIL_EMULATOR: "true",
      }).emailEmulator,
    ).toBe(false);
    expect(loadEnv({ ...base, NODE_ENV: "development" }).nodeEnv).toBe("development");
  });

  it("defaults the remote MCP private-endpoint escape to off", () => {
    expect(loadEnv(base).mcpAllowPrivateEndpoint).toBe(false);
    expect(loadEnv({ ...base, MCP_ALLOW_PRIVATE_ENDPOINT: "true" }).mcpAllowPrivateEndpoint).toBe(
      true,
    );
    expect(loadEnv({ ...base, MCP_ALLOW_PRIVATE_ENDPOINT: "1" }).mcpAllowPrivateEndpoint).toBe(
      false,
    );
  });
});

describe("OIDC environment", () => {
  const oidc = {
    OIDC_ISSUER: "https://identity.example.test",
    OIDC_CLIENT_ID: "fake-client",
    OIDC_CLIENT_SECRET: "fake-secret",
  };
  it("requires all credentials and an HTTPS issuer", () => {
    for (const [key, value] of Object.entries(oidc))
      expect(() => loadEnv({ ...base, [key]: value })).toThrow(/configured together/);
    expect(() =>
      loadEnv({ ...base, ...oidc, OIDC_ISSUER: "http://identity.example.test" }),
    ).toThrow(/HTTPS/);
  });
  it.each(["identity.example.test", "/issuer", "https://"])(
    "reports invalid issuer %s as a configuration error",
    (issuer) => {
      expect(() => loadEnv({ ...base, ...oidc, OIDC_ISSUER: issuer })).toThrow(
        "OIDC_ISSUER must be an HTTPS issuer URL",
      );
    },
  );
  it("guards password-only lockout without contacting discovery", () => {
    expect(() => loadEnv({ ...base, AUTH_PASSWORD_ENABLED: "false" })).toThrow(/requires OIDC/);
    expect(loadEnv({ ...base, ...oidc, AUTH_PASSWORD_ENABLED: "false" }).passwordAuth).toBe(false);
  });
  it("defaults to SSO with no policy bypass", () => {
    expect(loadEnv({ ...base, ...oidc }).oidc).toMatchObject({
      name: "SSO",
      allowSignupBypass: false,
      scopes: ["openid", "email", "profile"],
    });
    expect(
      loadEnv({ ...base, ...oidc, OIDC_ALLOW_SIGNUP_BYPASS: "true" }).oidc?.allowSignupBypass,
    ).toBe(true);
  });

  // Fork: OIDC_REQUIRED_GROUP (docs/fork-oidc-group-gate.md).
  describe("OIDC_REQUIRED_GROUP", () => {
    const sso = {
      ...base,
      OIDC_ISSUER: "https://identity.example.test/tenant/v2.0",
      OIDC_CLIENT_ID: "client",
      OIDC_CLIENT_SECRET: "secret",
      AUTH_PASSWORD_ENABLED: "false",
      OIDC_REQUIRED_GROUP: " 00000000-0000-4000-8000-0000000000aa ",
    };
    it("is off unless the variable is present", () => {
      const { OIDC_REQUIRED_GROUP: _group, ...unset } = sso;
      expect(loadEnv(unset).oidc?.requiredGroup).toBeUndefined();
    });
    it("loads the trimmed group", () => {
      expect(loadEnv(sso).oidc?.requiredGroup).toBe("00000000-0000-4000-8000-0000000000aa");
    });
    it.each([
      ["an empty group", { OIDC_REQUIRED_GROUP: "" }, /must not be empty/],
      ["a blank group", { OIDC_REQUIRED_GROUP: "  " }, /must not be empty/],
      [
        "no OIDC issuer",
        { OIDC_ISSUER: "", OIDC_CLIENT_ID: "", OIDC_CLIENT_SECRET: "" },
        /requires OIDC/,
      ],
      [
        "no OIDC at all",
        {
          OIDC_ISSUER: undefined,
          OIDC_CLIENT_ID: undefined,
          OIDC_CLIENT_SECRET: undefined,
          AUTH_PASSWORD_ENABLED: undefined,
        },
        /requires OIDC_ISSUER/,
      ],
      ["a missing client secret", { OIDC_CLIENT_SECRET: "" }, /configured together/],
      ["password auth on", { AUTH_PASSWORD_ENABLED: "true" }, /AUTH_PASSWORD_ENABLED=false/],
      ["password auth unset", { AUTH_PASSWORD_ENABLED: undefined }, /AUTH_PASSWORD_ENABLED=false/],
      ["messaging open signup", { MESSAGING_OPEN_SIGNUP: "true" }, /MESSAGING_OPEN_SIGNUP/],
    ])("fails closed at startup with %s", (_label, overrides, message) => {
      expect(() => loadEnv({ ...sso, ...overrides })).toThrow(message);
    });
  });

  // Fork: ACCESS_IDENTITY_ENABLED (docs/fork-access-identity.md).
  describe("ACCESS_IDENTITY_ENABLED", () => {
    const access = {
      ...base,
      ACCESS_IDENTITY_ENABLED: "true",
      ACCESS_IDENTITY_ISSUER: "https://team.access.example.test/",
      ACCESS_IDENTITY_AUDIENCE: " app-audience ",
      ACCESS_IDENTITY_CERTS_FILE: "/run/access/certs.json",
    };
    it("is off unless enabled", () => {
      expect(loadEnv(base).accessIdentity).toBeUndefined();
      expect(
        loadEnv({ ...access, ACCESS_IDENTITY_ENABLED: "false" }).accessIdentity,
      ).toBeUndefined();
    });
    it("loads the issuer origin, audience and certs file, with password auth off", () => {
      const env = loadEnv(access);
      expect(env.accessIdentity).toEqual({
        issuer: "https://team.access.example.test",
        audience: "app-audience",
        certsFile: "/run/access/certs.json",
      });
      expect(env.passwordAuth).toBe(false);
      expect(env.oidc).toBeUndefined();
    });
    it.each([
      ["a non-boolean flag", { ACCESS_IDENTITY_ENABLED: "yes" }, /true or false/],
      ["no issuer", { ACCESS_IDENTITY_ISSUER: "" }, /requires ACCESS_IDENTITY_ISSUER/],
      ["no audience", { ACCESS_IDENTITY_AUDIENCE: " " }, /requires ACCESS_IDENTITY_ISSUER/],
      [
        "no certs file",
        { ACCESS_IDENTITY_CERTS_FILE: undefined },
        /requires ACCESS_IDENTITY_ISSUER/,
      ],
      ["an HTTP issuer", { ACCESS_IDENTITY_ISSUER: "http://team.example.test" }, /HTTPS origin/],
      [
        "an issuer with a path",
        { ACCESS_IDENTITY_ISSUER: "https://team.example.test/x" },
        /HTTPS origin/,
      ],
      ["password auth on", { AUTH_PASSWORD_ENABLED: "true" }, /AUTH_PASSWORD_ENABLED/],
      [
        "OIDC configured",
        {
          OIDC_ISSUER: "https://identity.example.test/tenant/v2.0",
          OIDC_CLIENT_ID: "client",
          OIDC_CLIENT_SECRET: "secret",
        },
        /cannot be combined with OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET/,
      ],
      ["any OIDC setting", { OIDC_NAME: "SSO" }, /cannot be combined with OIDC_NAME/],
      ["the OIDC group gate", { OIDC_REQUIRED_GROUP: "group" }, /cannot be combined/],
      ["messaging open signup", { MESSAGING_OPEN_SIGNUP: "true" }, /MESSAGING_OPEN_SIGNUP/],
    ])("fails closed at startup with %s", (_label, overrides, message) => {
      expect(() => loadEnv({ ...access, ...overrides })).toThrow(message);
    });
    it("ignores blank OIDC settings", () => {
      expect(loadEnv({ ...access, OIDC_ISSUER: "", OIDC_NAME: " " }).accessIdentity).toBeDefined();
    });
  });
});
