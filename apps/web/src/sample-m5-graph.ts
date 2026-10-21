import type { FlowGraph } from "@awo/graph-schema";

/**
 * M5 sample parent graph with a Subflow placeholder.
 * Replace config.flow_version_id with a published child version id before test-run.
 */
export const SAMPLE_M5_GRAPH: FlowGraph = {
  id: "demo-m5",
  state_schema: { type: "object", properties: {} },
  nodes: [
    {
      id: "n_start",
      type: "Start",
      config: { label: "开始" },
      ui: { x: 40, y: 120 },
    },
    {
      id: "n_subflow",
      type: "Subflow",
      config: {
        label: "子流程（填 published flow_version_id）",
        flow_version_id: "",
      },
      ui: { x: 240, y: 120 },
    },
    {
      id: "n_end",
      type: "End",
      config: { label: "结束" },
      ui: { x: 480, y: 120 },
    },
  ],
  edges: [
    {
      id: "e1",
      source: "n_start",
      sourceHandle: "out",
      target: "n_subflow",
      targetHandle: "in",
      kind: "default",
      label: "",
    },
    {
      id: "e2",
      source: "n_subflow",
      sourceHandle: "out",
      target: "n_end",
      targetHandle: "in",
      kind: "default",
      label: "",
    },
  ],
};

export const SAMPLE_M5_HINT =
  "M5 样例：请先发布一个子流程，把 Subflow 节点的 flow_version_id 改成该 published 版本 id，再试运行。";
