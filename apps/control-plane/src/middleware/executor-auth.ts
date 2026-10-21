import { createMiddleware } from "hono/factory";

/**
 * Shared-secret auth for executor → control-plane callbacks.
 * Requires header `X-Executor-Token` matching env `EXECUTOR_TOKEN`.
 */
export const executorAuthMiddleware = createMiddleware(async (c, next) => {
  const expected = process.env.EXECUTOR_TOKEN;
  if (!expected) {
    return c.json({ error: "EXECUTOR_TOKEN not configured" }, 500);
  }
  const token = c.req.header("X-Executor-Token");
  if (!token || token !== expected) {
    return c.json({ error: "invalid or missing X-Executor-Token" }, 401);
  }
  await next();
});
