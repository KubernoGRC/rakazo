import type { Server } from "node:http";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { oidcProxyFetch, withOidcTransport } from "./oidc-transport.js";

let origin: Server;
let proxy: Server;
let originPort: number;
let proxyUrl: string;
let proxied: string[];

const listen = (server: Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
  );

beforeAll(async () => {
  origin = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        path: request.url,
        host: request.headers.host,
        ...(body ? { body, authorization: request.headers.authorization } : {}),
      }),
    );
  });
  originPort = await listen(origin);
  // A forward proxy that records each target and sends every request to
  // `origin`, so a host that does not resolve still answers through it. Plain
  // http targets arrive in absolute form; https targets arrive as CONNECT.
  proxy = createServer((request, response) => {
    const target = new URL(request.url ?? "");
    proxied.push(target.host);
    const upstream = httpRequest(
      {
        host: "127.0.0.1",
        port: originPort,
        path: target.pathname,
        method: request.method,
        headers: request.headers,
      },
      (answer) => {
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(response);
      },
    );
    request.pipe(upstream);
  });
  proxy.on("connect", (request, socket, head) => {
    proxied.push(request.url ?? "");
    const upstream = connect(originPort, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  proxyUrl = `http://127.0.0.1:${await listen(proxy)}`;
});
afterAll(async () => {
  await new Promise((resolve) => proxy.close(resolve));
  await new Promise((resolve) => origin.close(resolve));
});

const previousDispatcher = getGlobalDispatcher();
afterEach(() => {
  setGlobalDispatcher(previousDispatcher);
  vi.unstubAllGlobals();
});

describe("oidcProxyFetch", () => {
  it("keeps upstream behaviour when no HTTPS proxy is configured", () => {
    expect(oidcProxyFetch({ HTTP_PROXY: proxyUrl })).toBeUndefined();
  });

  it("goes through the proxy after the global dispatcher has been replaced", async () => {
    proxied = [];
    // Stand-in for an SSRF guard calling `setGlobalDispatcher(new Agent())`,
    // which takes global fetch off Node's env-proxy dispatcher.
    setGlobalDispatcher(new Agent());
    const transport = oidcProxyFetch({ HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl })!;

    const response = await transport("http://idp.invalid/.well-known/openid-configuration");

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      path: "/.well-known/openid-configuration",
      host: "idp.invalid",
    });
    expect(proxied).toEqual(["idp.invalid"]);
  });

  it("opens a CONNECT tunnel through the proxy for an https IdP", async () => {
    proxied = [];
    setGlobalDispatcher(new Agent());
    const transport = oidcProxyFetch({ HTTPS_PROXY: proxyUrl })!;

    // The test origin does not speak TLS, so the handshake fails after the
    // tunnel opens. The tunnel is what matters here.
    await expect(transport("https://idp.invalid/jwks")).rejects.toThrow();
    expect(proxied).toEqual(["idp.invalid:443"]);
  });

  it("carries a token request's form body, headers and signal", async () => {
    proxied = [];
    const transport = oidcProxyFetch({ HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl })!;

    const response = await transport("http://idp.invalid/token", {
      method: "POST",
      headers: new Headers({ authorization: "Basic placeholder" }),
      body: new URLSearchParams({ grant_type: "authorization_code", code: "abc" }),
      signal: AbortSignal.timeout(5_000),
    });

    expect(await response.json()).toEqual({
      path: "/token",
      host: "idp.invalid",
      body: "grant_type=authorization_code&code=abc",
      authorization: "Basic placeholder",
    });
    expect(proxied).toEqual(["idp.invalid"]);
  });

  it("goes direct for a host named in NO_PROXY", async () => {
    proxied = [];
    const transport = oidcProxyFetch({
      HTTPS_PROXY: proxyUrl,
      HTTP_PROXY: proxyUrl,
      NO_PROXY: "localhost,127.0.0.1",
    })!;

    const response = await transport(`http://127.0.0.1:${originPort}/jwks`);

    expect(((await response.json()) as { path: string }).path).toBe("/jwks");
    expect(proxied).toEqual([]);
  });
});

describe("withOidcTransport", () => {
  it("routes only calls made inside the operation through the transport", async () => {
    const direct = vi.fn(async () => new Response("direct"));
    const transport = vi.fn(async () => new Response("proxied"));
    vi.stubGlobal("fetch", direct);

    const inside = withOidcTransport(transport, async () => {
      await Promise.resolve();
      return (await fetch("https://idp.example.test/token")).text();
    });
    const outside = (await fetch("https://other.example.test/")).text();

    expect(await inside).toBe("proxied");
    expect(await outside).toBe("direct");
    expect(transport).toHaveBeenCalledTimes(1);
    expect(direct).toHaveBeenCalledTimes(1);
  });

  it("leaves the global fetch alone when there is no transport", async () => {
    const direct = vi.fn(async () => new Response("direct"));
    vi.stubGlobal("fetch", direct);

    await withOidcTransport(undefined, () => fetch("https://idp.example.test/"));

    expect(globalThis.fetch).toBe(direct);
    expect(direct).toHaveBeenCalledTimes(1);
  });

  it("wraps a global fetch installed after the first wrap", async () => {
    const transport = vi.fn(async () => new Response("proxied"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("first")),
    );
    await withOidcTransport(transport, () => fetch("https://idp.example.test/"));
    const replacement = vi.fn(async () => new Response("replacement"));
    vi.stubGlobal("fetch", replacement);

    await withOidcTransport(transport, () => fetch("https://idp.example.test/"));
    const outside = await (await fetch("https://other.example.test/")).text();

    expect(transport).toHaveBeenCalledTimes(2);
    expect(outside).toBe("replacement");
  });
});
