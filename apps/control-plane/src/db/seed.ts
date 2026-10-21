import { db, queryClient } from "./client";
import {
  flowTemplates,
  knowledgeBases,
  memberships,
  models,
  nodeDefs,
  projects,
  tools,
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
  HumanApproval: { color: "orange", icon: "check", shape: "rounded" },
  Input: { color: "teal", icon: "form", shape: "rounded" },
  Breakpoint: { color: "red", icon: "stop", shape: "diamond" },
  Code: { color: "purple", icon: "code", shape: "rounded" },
  Subflow: { color: "purple", icon: "nest", shape: "rounded" },
};

const NODE_CATEGORIES: Record<string, string> = {
  Start: "control",
  End: "control",
  Branch: "control",
  HTTP: "integration",
  LLM: "agent",
  Transform: "data",
  Emit: "debug",
  HumanApproval: "control",
  Input: "control",
  Breakpoint: "debug",
  Code: "integration",
  Subflow: "control",
};

const NODE_TYPES = [
  "Start",
  "End",
  "Branch",
  "HTTP",
  "LLM",
  "Transform",
  "Emit",
  "HumanApproval",
  "Input",
  "Breakpoint",
  "Code",
  "Subflow",
] as const;

const NODE_MIN_ROLE: Record<(typeof NODE_TYPES)[number], string> = {
  Start: "builder",
  End: "builder",
  Branch: "builder",
  HTTP: "builder",
  LLM: "builder",
  Transform: "builder",
  Emit: "builder",
  HumanApproval: "builder",
  Input: "builder",
  Breakpoint: "developer",
  Code: "developer",
  Subflow: "builder",
};

const SEED_USERS = [
  { id: "u_admin", email: "admin@example.com", name: "Admin User", role: "admin", memId: "mem_admin_demo" },
  { id: "u_dev", email: "dev@example.com", name: "Dev User", role: "developer", memId: "mem_dev_demo" },
  { id: "u_builder", email: "builder@example.com", name: "Builder User", role: "builder", memId: "mem_builder_demo" },
  { id: "u_viewer", email: "viewer@example.com", name: "Viewer User", role: "viewer", memId: "mem_viewer_demo" },
] as const;

function configSchemaFor(typeKey: string): Record<string, unknown> {
  if (typeKey === "HTTP") {
    return {
      type: "object",
      required: ["url"],
      properties: { url: { type: "string" } },
    };
  }
  if (typeKey === "Subflow") {
    return {
      type: "object",
      required: ["flow_version_id"],
      properties: { flow_version_id: { type: "string" } },
    };
  }
  return { type: "object", properties: {} };
}

async function seed() {
  for (const u of SEED_USERS) {
    await db
      .insert(users)
      .values({
        id: u.id,
        email: u.email,
        name: u.name,
      })
      .onConflictDoUpdate({
        target: users.id,
        set: { email: u.email, name: u.name },
      });
  }

  await db
    .insert(workspaces)
    .values({ id: "ws_demo", name: "Demo Workspace" })
    .onConflictDoUpdate({
      target: workspaces.id,
      set: { name: "Demo Workspace" },
    });

  for (const u of SEED_USERS) {
    await db
      .insert(memberships)
      .values({
        id: u.memId,
        workspaceId: "ws_demo",
        userId: u.id,
        role: u.role,
      })
      .onConflictDoUpdate({
        target: memberships.id,
        set: { role: u.role, workspaceId: "ws_demo", userId: u.id },
      });
  }

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
    const minRole = NODE_MIN_ROLE[typeKey];
    const configSchema = configSchemaFor(typeKey);
    await db
      .insert(nodeDefs)
      .values({
        id: `nd_${typeKey.toLowerCase()}`,
        workspaceId: "ws_demo",
        typeKey,
        category: NODE_CATEGORIES[typeKey],
        configSchema,
        uiMeta: UI_META[typeKey],
        minRole,
      })
      .onConflictDoUpdate({
        target: nodeDefs.id,
        set: {
          typeKey,
          category: NODE_CATEGORIES[typeKey],
          configSchema,
          uiMeta: UI_META[typeKey],
          minRole,
          workspaceId: "ws_demo",
        },
      });
  }


  await db
    .insert(tools)
    .values({
      id: "tool_demo_echo",
      workspaceId: "ws_demo",
      name: "demo_echo",
      kind: "function",
      configJson: { secret_ref: "env:DEMO_ECHO" },
      allowedRoles: ["builder", "developer", "admin"],
    })
    .onConflictDoUpdate({
      target: tools.id,
      set: {
        name: "demo_echo",
        kind: "function",
        configJson: { secret_ref: "env:DEMO_ECHO" },
        allowedRoles: ["builder", "developer", "admin"],
        workspaceId: "ws_demo",
        updatedAt: new Date(),
      },
    });

  await db
    .insert(models)
    .values({
      id: "model_demo_stub",
      workspaceId: "ws_demo",
      provider: "stub",
      name: "demo_stub",
      configJson: {},
    })
    .onConflictDoUpdate({
      target: models.id,
      set: {
        provider: "stub",
        name: "demo_stub",
        configJson: {},
        workspaceId: "ws_demo",
        updatedAt: new Date(),
      },
    });

  await db
    .insert(knowledgeBases)
    .values({
      id: "kb_demo",
      workspaceId: "ws_demo",
      name: "demo_kb",
      configJson: {},
    })
    .onConflictDoUpdate({
      target: knowledgeBases.id,
      set: {
        name: "demo_kb",
        configJson: {},
        workspaceId: "ws_demo",
        updatedAt: new Date(),
      },
    });


  const demoTemplateGraph = {
    id: "tpl_demo_basic_graph",
    state_schema: { type: "object", properties: {} },
    nodes: [
      { id: "s", type: "Start", config: {}, ui: { x: 0, y: 0 } },
      { id: "t", type: "Transform", config: { set: { hello: "template" } }, ui: { x: 160, y: 0 } },
      { id: "e", type: "End", config: {}, ui: { x: 320, y: 0 } },
    ],
    edges: [
      { id: "e1", source: "s", sourceHandle: "out", target: "t", targetHandle: "in", kind: "default", label: "" },
      { id: "e2", source: "t", sourceHandle: "out", target: "e", targetHandle: "in", kind: "default", label: "" },
    ],
  };

  await db
    .insert(flowTemplates)
    .values({
      id: "tpl_demo_basic",
      workspaceId: "ws_demo",
      name: "Demo Basic",
      description: "Start → Transform → End sample template",
      graphJson: demoTemplateGraph,
      sourceFlowVersionId: null,
      createdBy: "u_dev",
    })
    .onConflictDoUpdate({
      target: flowTemplates.id,
      set: {
        name: "Demo Basic",
        description: "Start → Transform → End sample template",
        graphJson: demoTemplateGraph,
        workspaceId: "ws_demo",
        createdBy: "u_dev",
      },
    });

  console.log(
    "seed complete: u_admin|u_dev|u_builder|u_viewer, ws_demo, p_demo, node_defs + Subflow + tpl_demo_basic + assets",
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
