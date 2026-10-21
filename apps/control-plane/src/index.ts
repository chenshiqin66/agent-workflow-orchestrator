import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { fileURLToPath } from "node:url";
import { authMiddleware, type AuthVariables } from "./middleware/auth";
import { flowsRoutes } from "./routes/flows";
import { flowVersionRoutes } from "./routes/flow-versions";

export const PACKAGE = "@awo/control-plane";

const app = new Hono<{ Variables: AuthVariables }>();

app.get("/health", (c) => c.json({ ok: true, package: PACKAGE }));

app.use("*", async (c, next) => {
  if (c.req.path === "/health") {
    return next();
  }
  return authMiddleware(c, next);
});

app.route("/", flowsRoutes);
app.route("/", flowVersionRoutes);

export { app };

const isMain =
  process.argv[1] != null &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const port = Number(process.env.PORT ?? 8787);
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`control-plane listening on http://localhost:${info.port}`);
  });
}
