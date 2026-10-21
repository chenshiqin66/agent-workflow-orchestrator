import { createMiddleware } from "hono/factory";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { memberships } from "../db/schema";

export type AuthVariables = {
  userId: string;
  workspaceId: string;
  role: string;
};

export const authMiddleware = createMiddleware<{ Variables: AuthVariables }>(
  async (c, next) => {
    const userId = c.req.header("X-User-Id");
    if (!userId) {
      return c.json({ error: "missing X-User-Id" }, 401);
    }

    const membership = await db.query.memberships.findFirst({
      where: eq(memberships.userId, userId),
    });
    if (!membership) {
      return c.json({ error: "no workspace membership" }, 403);
    }

    c.set("userId", userId);
    c.set("workspaceId", membership.workspaceId);
    c.set("role", membership.role);
    await next();
  },
);
