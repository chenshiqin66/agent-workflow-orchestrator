import type { FlowGraph } from "@awo/graph-schema";

/**
 * M3 sample: Start → Transform → Breakpoint → HumanApproval
 * → (success Emit → End) / (failure End)
 */
export const SAMPLE_M3_GRAPH: FlowGraph = {
  id: "demo-m3",
  state_schema: { type: "object", properties: {} },
  nodes: [
    {
      id: "n_start",
      type: "Start",
      config: { label: "开始" },
      ui: { x: 40, y: 140 },
    },
    {
      id: "n_transform",
      type: "Transform",
      config: {
        label: "预处理",
        assignments: { label: "m3-prep", processed: true },
      },
      ui: { x: 220, y: 140 },
    },
    {
      id: "n_bp",
      type: "Breakpoint",
      config: { label: "断点" },
      ui: { x: 420, y: 140 },
    },
    {
      id: "n_approve",
      type: "HumanApproval",
      config: { label: "人工审批" },
      ui: { x: 620, y: 120 },
    },
    {
      id: "n_emit",
      type: "Emit",
      config: { label: "Emit 通过", message: "approved" },
      ui: { x: 840, y: 40 },
    },
    {
      id: "n_end_ok",
      type: "End",
      config: { label: "成功结束" },
      ui: { x: 1040, y: 40 },
    },
    {
      id: "n_end_fail",
      type: "End",
      config: { label: "驳回结束" },
      ui: { x: 840, y: 240 },
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
      target: "n_bp",
      targetHandle: "in",
      kind: "default",
      label: "",
    },
    {
      id: "e3",
      source: "n_bp",
      sourceHandle: "out",
      target: "n_approve",
      targetHandle: "in",
      kind: "default",
      label: "",
    },
    {
      id: "e4",
      source: "n_approve",
      sourceHandle: "success",
      target: "n_emit",
      targetHandle: "in",
      kind: "success",
      label: "approve",
    },
    {
      id: "e5",
      source: "n_approve",
      sourceHandle: "failure",
      target: "n_end_fail",
      targetHandle: "in",
      kind: "failure",
      label: "reject",
    },
    {
      id: "e6",
      source: "n_emit",
      sourceHandle: "out",
      target: "n_end_ok",
      targetHandle: "in",
      kind: "success",
      label: "",
    },
  ],
};

export const SAMPLE_M3_INPUT = {
  question: "m3-demo",
  flag: true,
};
