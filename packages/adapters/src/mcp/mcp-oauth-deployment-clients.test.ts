import { describe, expect, it } from "vitest";
import { launchOAuthClient } from "./mcp-oauth.js";
import {
  deploymentClientFor,
  deploymentOAuthClientSecrets,
  deploymentOAuthClientsFromEnv,
} from "./mcp-oauth-deployment-clients.js";

const GITHUB = {
  MCP_OAUTH_CLIENTS: "GITHUB",
  MCP_OAUTH_CLIENT_GITHUB_ISSUER: "https://github.com/login/oauth",
  MCP_OAUTH_CLIENT_GITHUB_ID: "Iv1.example",
  MCP_OAUTH_CLIENT_GITHUB_SECRET: "example-client-secret",
  MCP_OAUTH_CLIENT_GITHUB_SCOPE: "repo:read",
};

describe("deploymentOAuthClientsFromEnv", () => {
  it("is empty when nothing is configured", () => {
    expect(deploymentOAuthClientsFromEnv({}).size).toBe(0);
    expect(deploymentOAuthClientsFromEnv({ MCP_OAUTH_CLIENTS: " " }).size).toBe(0);
  });

  it("reads each labelled client, keyed by its normalized issuer", () => {
    const clients = deploymentOAuthClientsFromEnv({
      ...GITHUB,
      MCP_OAUTH_CLIENTS: "GITHUB, ENTRA",
      MCP_OAUTH_CLIENT_ENTRA_ISSUER: "https://login.example.test/tenant/v2.0",
      MCP_OAUTH_CLIENT_ENTRA_ID: "entra-client",
      MCP_OAUTH_CLIENT_ENTRA_AUTHORIZATION_PARAMS: "prompt=select_account",
    });

    expect([...clients.keys()]).toEqual([
      "https://github.com/login/oauth",
      "https://login.example.test/tenant/v2.0",
    ]);
    expect(clients.get("https://github.com/login/oauth")).toEqual({
      issuer: "https://github.com/login/oauth",
      client_id: "Iv1.example",
      client_secret: "example-client-secret",
      scope: "repo:read",
    });
    expect(clients.get("https://login.example.test/tenant/v2.0")).toEqual({
      issuer: "https://login.example.test/tenant/v2.0",
      client_id: "entra-client",
      authorization_params: "prompt=select_account",
    });
  });

  it.each([
    [{ MCP_OAUTH_CLIENTS: "github" }, "not a valid label"],
    [{ MCP_OAUTH_CLIENTS: "GITHUB" }, "MCP_OAUTH_CLIENT_GITHUB_ISSUER is required"],
    [{ ...GITHUB, MCP_OAUTH_CLIENT_GITHUB_ID: "" }, "MCP_OAUTH_CLIENT_GITHUB_ID is required"],
    [{ ...GITHUB, MCP_OAUTH_CLIENT_GITHUB_ISSUER: "http://github.com/login/oauth" }, "HTTPS"],
    [{ ...GITHUB, MCP_OAUTH_CLIENT_GITHUB_ISSUER: "https://u:p@github.com/" }, "HTTPS"],
    [{ ...GITHUB, MCP_OAUTH_CLIENT_GITHUB_ISSUER: "not a url" }, "HTTPS"],
    [{ ...GITHUB, MCP_OAUTH_CLIENTS: "GITHUB,GITHUB" }, "more than once"],
    [
      { ...GITHUB, MCP_OAUTH_CLIENT_GITHUB_AUTHORIZATION_PARAMS: "redirect_uri=https://x" },
      "AUTHORIZATION_PARAMS",
    ],
  ])("refuses a malformed configuration (%j)", (env, message) => {
    expect(() => deploymentOAuthClientsFromEnv(env)).toThrow(message);
  });
});

describe("deploymentClientFor", () => {
  const clients = deploymentOAuthClientsFromEnv(GITHUB);

  it("matches the issuer however its URL is spelled", () => {
    expect(deploymentClientFor(clients, "https://GITHUB.com/login/oauth")?.client_id).toBe(
      "Iv1.example",
    );
  });

  it("matches nothing else", () => {
    expect(deploymentClientFor(clients, "https://github.com/login")).toBeUndefined();
    expect(deploymentClientFor(clients, undefined)).toBeUndefined();
    expect(deploymentClientFor(clients, "not a url")).toBeUndefined();
  });

  it("lists secrets for redaction", () => {
    expect(deploymentOAuthClientSecrets(clients)).toEqual(["example-client-secret"]);
  });
});

describe("launchOAuthClient", () => {
  const clients = deploymentOAuthClientsFromEnv({
    ...GITHUB,
    MCP_OAUTH_CLIENT_GITHUB_ISSUER: "https://auth.example.test/",
  });

  it("gives a stdio server the deployment client's id but never its secret", () => {
    const material = {
      oauthClient: {
        client_id: "user-client",
        client_secret: "user-secret",
        authorization_server: "https://auth.example.test/",
      },
    };
    expect(launchOAuthClient(material, clients)).toEqual({
      client_id: "Iv1.example",
      scope: "repo:read",
    });
  });

  it("gives a stdio server its user's own client for other issuers", () => {
    const material = {
      oauthClient: {
        client_id: "user-client",
        client_secret: "user-secret",
        authorization_server: "https://other.example.test/",
      },
    };
    expect(launchOAuthClient(material, clients)).toEqual({
      client_id: "user-client",
      client_secret: "user-secret",
      scope: undefined,
    });
  });
});
