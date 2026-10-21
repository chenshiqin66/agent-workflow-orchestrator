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

export function hashGraph(graph: FlowGraph): string {
  const canonical = JSON.stringify(sortKeys(graph));
  return createHash("sha256").update(canonical).digest("hex");
}
