import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { fileURLToPath } from "node:url";
import { authMiddleware, type AuthVariables } from "./middleware/auth";
import { flowsRoutes } from "./routes/flows";
import { flowVersionRoutes } from "./routes/flow-versions";

export const PACKAGE = "@awo/control-plane";

const app = new Hono<{ Variables: AuthVariables }>();

app.use(
  "*",
  cors({
    origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
    allowHeaders: ["Content-Type", "X-User-Id"],
    allowMethods: ["GET", "POST", "PUT", "OPTIONS"],
  }),
);

app.get("/health", (c) => c.json({ ok: true, package: PACKAGE }));

app.use("*", async (c, next) => {
  if (c.req.path === "/health" || c.req.method === "OPTIONS") {
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
