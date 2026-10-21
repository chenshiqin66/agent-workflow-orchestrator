import { and, eq } from "drizzle-orm";
import type { FlowGraph } from "@awo/graph-schema";
import { roleAtLeast } from "../auth/roles";
import { db } from "../db/client";
import {
  flowVersions,
  knowledgeBases,
  models,
  nodeDefs,
  runs,
  tools,
} from "../db/schema";
import { expandSubflows, SubflowExpandError } from "./subflow-expand";
import { resolvePublishedForWorkspace } from "./subflow-resolve";

export type GateCheck = { id: string; ok: boolean; message?: string };
export type GateResult = { ok: boolean; checks: GateCheck[] };

type NodeDefRow = {
  typeKey: string;
  minRole: string;
  configSchema: unknown;
};

function isEmptyValue(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === "string" && v.trim() === "") return true;
  return false;
}

async function loadNodeDefs(workspaceId: string): Promise<NodeDefRow[]> {
  return db
    .select({
      typeKey: nodeDefs.typeKey,
      minRole: nodeDefs.minRole,
      configSchema: nodeDefs.configSchema,
    })
    .from(nodeDefs)
    .where(eq(nodeDefs.workspaceId, workspaceId));
}

async function toolExists(workspaceId: string, toolId: string): Promise<boolean> {
  const row = await db.query.tools.findFirst({
    where: and(eq(tools.id, toolId), eq(tools.workspaceId, workspaceId)),
  });
  return Boolean(row);
}

async function modelExists(workspaceId: string, modelId: string): Promise<boolean> {
  const row = await db.query.models.findFirst({
    where: and(eq(models.id, modelId), eq(models.workspaceId, workspaceId)),
  });
  return Boolean(row);
}

async function kbExists(workspaceId: string, kbId: string): Promise<boolean> {
  const row = await db.query.knowledgeBases.findFirst({
    where: and(
      eq(knowledgeBases.id, kbId),
      eq(knowledgeBases.workspaceId, workspaceId),
    ),
  });
  return Boolean(row);
}

async function findSucceededTestRunWithHash(
  flowId: string,
  draftSchemaHash: string,
): Promise<boolean> {
  const versions = await db
    .select({ id: flowVersions.id, schemaHash: flowVersions.schemaHash })
    .from(flowVersions)
    .where(eq(flowVersions.flowId, flowId));
  const matchingIds = versions
    .filter((v) => v.schemaHash === draftSchemaHash)
    .map((v) => v.id);
  if (matchingIds.length === 0) return false;

  for (const versionId of matchingIds) {
    const hit = await db.query.runs.findFirst({
      where: and(
        eq(runs.flowVersionId, versionId),
        eq(runs.trigger, "test"),
        eq(runs.status, "succeeded"),
      ),
    });
    if (hit) return true;
  }
  return false;
}

async function checkRequiredConfig(
  workspaceId: string,
  draftGraph: FlowGraph,
  defs: NodeDefRow[],
): Promise<string[]> {
  const problems: string[] = [];

  for (const node of draftGraph.nodes) {
    const def = defs.find((d) => d.typeKey === node.type);
    if (!def) {
      problems.push(`unknown type ${node.type}`);
      continue;
    }

    const schema = (def.configSchema ?? {}) as {
      required?: string[];
    };
    const required = schema.required ?? [];
    const config = (node.config ?? {}) as Record<string, unknown>;

    for (const key of required) {
      if (isEmptyValue(config[key])) {
        problems.push(`node ${node.id}: missing config.${key}`);
      }
    }

    // Type-specific extras
    if (node.type === "HTTP") {
      if (isEmptyValue(config.url)) {
        const msg = `node ${node.id}: missing config.url`;
        if (!problems.includes(msg)) problems.push(msg);
      }
    }

    if (node.type === "Tool") {
      const toolId = config.tool_id;
      if (isEmptyValue(toolId)) {
        problems.push(`node ${node.id}: missing config.tool_id`);
      } else if (!(await toolExists(workspaceId, String(toolId)))) {
        problems.push(`node ${node.id}: tool_id not found`);
      }
    }

    if (node.type === "LLM" || node.type === "Agent") {
      if ("model_id" in config || required.includes("model_id")) {
        const modelId = config.model_id;
        if (isEmptyValue(modelId)) {
          problems.push(`node ${node.id}: missing config.model_id`);
        } else if (!(await modelExists(workspaceId, String(modelId)))) {
          problems.push(`node ${node.id}: model_id not found`);
        }
      }
    }

    if (node.type === "KnowledgeRetrieve") {
      if ("knowledge_base_id" in config || required.includes("knowledge_base_id")) {
        const kbId = config.knowledge_base_id;
        if (isEmptyValue(kbId)) {
          problems.push(`node ${node.id}: missing config.knowledge_base_id`);
        } else if (!(await kbExists(workspaceId, String(kbId)))) {
          problems.push(`node ${node.id}: knowledge_base_id not found`);
        }
      }
    }
  }

  return problems;
}

export async function evaluatePublishGate(args: {
  workspaceId: string;
  flowId: string;
  draftGraph: FlowGraph;
  draftSchemaHash: string;
  publisherRole: string;
  publishedVersionId: string | null;
}): Promise<GateResult> {
  const {
    workspaceId,
    flowId,
    draftGraph,
    draftSchemaHash,
    publisherRole,
    publishedVersionId,
  } = args;

  const defs = await loadNodeDefs(workspaceId);
  const checks: GateCheck[] = [];

  const configProblems = await checkRequiredConfig(workspaceId, draftGraph, defs);
  checks.push({
    id: "required_config",
    ok: configProblems.length === 0,
    message: configProblems[0],
  });

  if (publishedVersionId == null) {
    checks.push({
      id: "successful_test_run",
      ok: true,
      message: "bootstrap_skip",
    });
  } else {
    const hit = await findSucceededTestRunWithHash(flowId, draftSchemaHash);
    checks.push({
      id: "successful_test_run",
      ok: hit,
      message: hit
        ? undefined
        : `no succeeded test run for hash ${draftSchemaHash}`,
    });
  }

  const roleProblems: string[] = [];
  for (const node of draftGraph.nodes) {
    const def = defs.find((d) => d.typeKey === node.type);
    if (!def || !roleAtLeast(publisherRole, def.minRole)) {
      roleProblems.push(
        `node ${node.id}: type ${node.type} requires ${def?.minRole ?? "?"}`,
      );
    }
  }
  checks.push({
    id: "role_nodes",
    ok: roleProblems.length === 0,
    message: roleProblems[0],
  });

  try {
    await expandSubflows(draftGraph, {
      resolvePublished: (id) => resolvePublishedForWorkspace(id, workspaceId),
    });
    checks.push({ id: "subflow_refs", ok: true });
  } catch (e) {
    const err = e as SubflowExpandError;
    checks.push({
      id: "subflow_refs",
      ok: false,
      message:
        err instanceof SubflowExpandError
          ? `${err.code}: ${err.message}`
          : "subflow expand failed",
    });
  }

  return { ok: checks.every((c) => c.ok), checks };
}
