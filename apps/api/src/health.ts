import { Hono } from "hono";

/**
 * `/health` is public liveness, so it stays a constant body. Deployment details are for
 * operators on the API port; a reverse proxy adds forwarding headers, so a request that
 * carries them came through the public edge and gets no details.
 */
export function healthRoutes(
  details: () => Record<string, unknown>,
  /** Fork: a reason the instance must not take traffic yet, if any. */
  unready?: () => Promise<string | undefined>,
) {
  const app = new Hono();
  app.get("/ready", async (c) => {
    const degraded = details().degraded === true;
    const reason = await unready?.();
    if (reason) return c.json({ ok: false, degraded, reason }, 503);
    return c.json({ ok: !degraded, degraded }, degraded ? 503 : 200);
  });
  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/internal/health", (c) => {
    if (c.req.header("x-forwarded-for") || c.req.header("forwarded")) return c.notFound();
    return c.json({ ok: true, ...details() });
  });
  return app;
}
