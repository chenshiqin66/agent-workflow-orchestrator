import { createHash } from "node:crypto";
import type { FlowGraph } from "./graph";

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.keys(value as object)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sortKeys((value as Record<string, unknown>)[k]);
        return acc;
      }, {});
  }
  return value;
}

/**
 * Content hash of graph topology + config.
 *
 * Excludes `graph.id` so draft and published rows that share the same
 * nodes/edges/state_schema produce the same schemaHash (version identity
 * lives in flow_versions.id / version, not in the hash).
 */
export function hashGraph(graph: FlowGraph): string {
  const { id: _versionRowId, ...content } = graph;
  const canonical = JSON.stringify(sortKeys(content));
  return createHash("sha256").update(canonical).digest("hex");
}
