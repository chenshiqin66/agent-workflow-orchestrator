import type { FlowGraph } from "@awo/graph-schema";

/**
 * M2-executable sample: Start → Transform → Branch(flag) → Emit → End
 * (+ failure End). Matches executor-py node subset.
 */
export const SAMPLE_M2_GRAPH: FlowGraph = {
  id: "demo-m2",
  state_schema: { type: "object", properties: {} },
  nodes: [
    {
      id: "n_start",
      type: "Start",
      config: { label: "开始" },
      ui: { x: 40, y: 120 },
    },
    {
      id: "n_transform",
      type: "Transform",
      config: {
        label: "标记已处理",
        assignments: { label: "m2-ok", processed: true },
      },
      ui: { x: 220, y: 120 },
    },
    {
      id: "n_branch",
      type: "Branch",
      config: {
        label: "flag == true?",
        expression: "state.flag == true",
      },
      ui: { x: 420, y: 100, variant: "decision" },
    },
    {
      id: "n_emit",
      type: "Emit",
      config: { label: "Emit 成功", message: "flag was true" },
      ui: { x: 620, y: 60 },
    },
    {
      id: "n_end_ok",
      type: "End",
      config: { label: "成功结束" },
      ui: { x: 820, y: 60 },
    },
    {
      id: "n_end_fail",
      type: "End",
      config: { label: "失败结束" },
      ui: { x: 820, y: 220 },
    },
  ],
  edges: [
    {
      id: "e1",
      source: "n_start",
      sourceHandle: "out",
      target: "n_transform",
      targetHandle: "in",
      kind: "default",
      label: "",
    },
    {
      id: "e2",
      source: "n_transform",
      sourceHandle: "out",
      target: "n_branch",
      targetHandle: "in",
      kind: "default",
      label: "",
    },
    {
      id: "e3",
      source: "n_branch",
      sourceHandle: "success",
      target: "n_emit",
      targetHandle: "in",
      kind: "success",
      label: "yes",
    },
    {
      id: "e4",
      source: "n_branch",
      sourceHandle: "failure",
      target: "n_end_fail",
      targetHandle: "in",
      kind: "failure",
      label: "no",
    },
    {
      id: "e5",
      source: "n_emit",
      sourceHandle: "out",
      target: "n_end_ok",
      targetHandle: "in",
      kind: "success",
      label: "",
    },
  ],
};

export const SAMPLE_M2_INPUT = {
  question: "demo",
  flag: true,
};
