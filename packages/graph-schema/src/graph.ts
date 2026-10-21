import { z } from "zod";

export const EdgeKindSchema = z.enum(["success", "failure", "default"]);
export type EdgeKind = z.infer<typeof EdgeKindSchema>;

export const GraphNodeSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  config: z.record(z.unknown()).default({}),
  ui: z.object({
    x: z.number(),
    y: z.number(),
    variant: z.string().optional(),
  }),
});

export type GraphNode = z.infer<typeof GraphNodeSchema>;

export const GraphEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  sourceHandle: z.string().min(1),
  target: z.string().min(1),
  targetHandle: z.string().min(1),
  kind: EdgeKindSchema.default("default"),
  label: z.string().optional().default(""),
});

export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

export const FlowGraphSchema = z.object({
  id: z.string().min(1),
  state_schema: z.record(z.unknown()),
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
});

export type FlowGraph = z.infer<typeof FlowGraphSchema>;

export function parseFlowGraph(input: unknown): FlowGraph {
  return FlowGraphSchema.parse(input);
}
