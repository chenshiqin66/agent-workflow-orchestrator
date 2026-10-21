import { db, queryClient } from "./client";
import {
  memberships,
  nodeDefs,
  projects,
  users,
  workspaces,
} from "./schema";

const UI_META: Record<
  string,
  { color: string; icon: string; shape: string }
> = {
  Start: { color: "blue", icon: "user", shape: "rounded" },
  Branch: { color: "blue", icon: "scales", shape: "diamond" },
  HTTP: { color: "blue", icon: "database", shape: "rounded" },
  LLM: { color: "blue", icon: "bulb", shape: "rounded" },
  End: { color: "green", icon: "chat", shape: "rounded" },
  Transform: { color: "blue", icon: "transform", shape: "rounded" },
  Emit: { color: "blue", icon: "broadcast", shape: "rounded" },
};

const NODE_CATEGORIES: Record<string, string> = {
  Start: "control",
  End: "control",
  Branch: "control",
  HTTP: "integration",
  LLM: "agent",
  Transform: "data",
  Emit: "debug",
};

const NODE_TYPES = [
  "Start",
  "End",
  "Branch",
  "HTTP",
  "LLM",
  "Transform",
  "Emit",
] as const;

async function seed() {
  await db
    .insert(users)
    .values({
      id: "u_dev",
      email: "dev@example.com",
      name: "Dev User",
    })
    .onConflictDoUpdate({
      target: users.id,
      set: { email: "dev@example.com", name: "Dev User" },
    });

  await db
    .insert(workspaces)
    .values({ id: "ws_demo", name: "Demo Workspace" })
    .onConflictDoUpdate({
      target: workspaces.id,
      set: { name: "Demo Workspace" },
    });

  await db
    .insert(memberships)
    .values({
      id: "mem_dev_demo",
      workspaceId: "ws_demo",
      userId: "u_dev",
      role: "developer",
    })
    .onConflictDoUpdate({
      target: memberships.id,
      set: { role: "developer", workspaceId: "ws_demo", userId: "u_dev" },
    });

  await db
    .insert(projects)
    .values({
      id: "p_demo",
      workspaceId: "ws_demo",
      name: "Demo Project",
    })
    .onConflictDoUpdate({
      target: projects.id,
      set: { name: "Demo Project", workspaceId: "ws_demo" },
    });

  for (const typeKey of NODE_TYPES) {
    await db
      .insert(nodeDefs)
      .values({
        id: `nd_${typeKey.toLowerCase()}`,
        workspaceId: "ws_demo",
        typeKey,
        category: NODE_CATEGORIES[typeKey],
        configSchema: { type: "object", properties: {} },
        uiMeta: UI_META[typeKey],
        minRole: "builder",
      })
      .onConflictDoUpdate({
        target: nodeDefs.id,
        set: {
          typeKey,
          category: NODE_CATEGORIES[typeKey],
          configSchema: { type: "object", properties: {} },
          uiMeta: UI_META[typeKey],
          minRole: "builder",
          workspaceId: "ws_demo",
        },
      });
  }

  console.log(
    "seed complete: u_dev, ws_demo, p_demo, node_defs Start|End|Branch|HTTP|LLM|Transform|Emit",
  );
}

seed()
  .then(async () => {
    await queryClient.end({ timeout: 5 });
  })
  .catch(async (err) => {
    console.error(err);
    await queryClient.end({ timeout: 5 });
    process.exit(1);
  });
