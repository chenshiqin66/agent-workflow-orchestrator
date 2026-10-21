import { useCallback, useEffect, useMemo, useState } from "react";
import type { FlowGraph } from "@awo/graph-schema";
import { FlowCanvas } from "./canvas/FlowCanvas";
import { NodePalette } from "./canvas/NodePalette";
import {
  ApiError,
  createApiClient,
  type ApiClient,
} from "./api/client";
import { saveThenPublish } from "./api/save-then-publish";
import { SAMPLE_M2_GRAPH } from "./sample-m2-graph";
import { SAMPLE_M3_GRAPH } from "./sample-m3-graph";
import { SAMPLE_M5_GRAPH, SAMPLE_M5_HINT } from "./sample-m5-graph";
import { TestRunPanel } from "./run/TestRunPanel";
import { toggleBreakpointOnServer } from "./run/breakpoints";
import {
  USER_STORAGE_KEY,
  UserSwitcher,
  roleForUser,
} from "./auth/UserSwitcher";
import { AssetsPanel } from "./assets/AssetsPanel";
import { TemplatesPanel } from "./templates/TemplatesPanel";
import { MetricsPanel } from "./metrics/MetricsPanel";
import "./styles/m4.css";
import "./styles/m5.css";

const PROJECT_ID = "p_demo";
const FLOW_ID_KEY = "awo.demoFlowId";

function readStoredUserId(): string {
  try {
    const v = localStorage.getItem(USER_STORAGE_KEY);
    if (v && ["u_dev", "u_builder", "u_viewer", "u_admin"].includes(v)) return v;
  } catch {
    /* ignore */
  }
  return "u_dev";
}

function emptyGraph(id: string): FlowGraph {
  return {
    id,
    state_schema: { type: "object", properties: {} },
    nodes: [],
    edges: [],
  };
}

function withSampleContent(id: string): FlowGraph {
  return { ...SAMPLE_M3_GRAPH, id };
}

function withM2Sample(id: string): FlowGraph {
  return { ...SAMPLE_M2_GRAPH, id };
}

function withM3Sample(id: string): FlowGraph {
  return { ...SAMPLE_M3_GRAPH, id };
}

function withM5Sample(id: string): FlowGraph {
  return { ...SAMPLE_M5_GRAPH, id };
}

export function App() {
  const [userId, setUserId] = useState(readStoredUserId);
  const client: ApiClient = useMemo(
    () => createApiClient({ userId }),
    [userId],
  );
  const [flowId, setFlowId] = useState<string | null>(null);
  const [flowName, setFlowName] = useState("未命名流程");
  const [graph, setGraph] = useState<FlowGraph>(() => withSampleContent("local"));
  const [graphEpoch, setGraphEpoch] = useState(0);
  const [publishedVersionId, setPublishedVersionId] = useState<string | null>(
    null,
  );
  const [draftHash, setDraftHash] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("就绪");
  const [busy, setBusy] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [breakpointNodeIds, setBreakpointNodeIds] = useState<string[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  const applyLoaded = useCallback(
    (detail: {
      id: string;
      name: string;
      publishedVersionId: string | null;
      draft: { schemaHash: string } | null;
      graph: FlowGraph | null;
    }) => {
      setFlowId(detail.id);
      setFlowName(detail.name);
      setPublishedVersionId(detail.publishedVersionId);
      setDraftHash(detail.draft?.schemaHash ?? null);
      const g =
        detail.graph && Array.isArray(detail.graph.nodes)
          ? (detail.graph as FlowGraph)
          : emptyGraph(detail.draft?.schemaHash ? detail.id : detail.id);
      const normalized: FlowGraph = {
        ...g,
        id: typeof g.id === "string" && g.id.length > 0 ? g.id : detail.id,
        state_schema: g.state_schema ?? { type: "object", properties: {} },
        nodes: g.nodes ?? [],
        edges: g.edges ?? [],
      };
      setGraph(normalized);
      setGraphEpoch((n) => n + 1);
      localStorage.setItem(FLOW_ID_KEY, detail.id);
    },
    [],
  );

  const loadFlow = useCallback(
    async (id: string) => {
      setBusy(true);
      setStatus(`加载 ${id}…`);
      try {
        const detail = await client.getFlow(id);
        applyLoaded(detail);
        setStatus(`已打开「${detail.name}」`);
      } catch (e) {
        setStatus(`加载失败: ${(e as Error).message}`);
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [applyLoaded, client],
  );

  useEffect(() => {
    const saved = localStorage.getItem(FLOW_ID_KEY);
    if (!saved) return;
    void loadFlow(saved).catch(() => {
      localStorage.removeItem(FLOW_ID_KEY);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open once on mount
  }, []);

  const onCreate = async () => {
    setBusy(true);
    setStatus("创建流程…");
    try {
      const created = await client.createFlow(PROJECT_ID, "客服流水线");
      const seeded = withSampleContent(created.id);
      const saved = await client.saveDraft(created.id, seeded);
      const detail = await client.getFlow(created.id);
      applyLoaded(detail);
      setDraftHash(saved.schemaHash);
      setStatus(`已创建并写入演示图（hash ${saved.schemaHash.slice(0, 8)}…）`);
    } catch (e) {
      setStatus(`创建失败: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const onLoadM2Sample = () => {
    const id = flowId ?? "local";
    setGraph(withM2Sample(id));
    setGraphEpoch((n) => n + 1);
    setStatus(
      flowId
        ? "已载入 M2 可执行样例（请保存并发布后试运行）"
        : "已载入 M2 可执行样例（请先新建流程再保存发布）",
    );
  };

  const onLoadM3Sample = () => {
    const id = flowId ?? "local";
    setGraph(withM3Sample(id));
    setGraphEpoch((n) => n + 1);
    setStatus(
      flowId
        ? "已载入 M3 断点/审批样例（请保存并发布后试运行）"
        : "已载入 M3 断点/审批样例（请先新建流程再保存发布）",
    );
  };
  const onLoadM5Sample = () => {
    const id = flowId ?? "local";
    setGraph(withM5Sample(id));
    setGraphEpoch((n) => n + 1);
    setStatus(SAMPLE_M5_HINT);
  };

  // Single source of truth: refresh from server whenever active run changes
  useEffect(() => {
    if (!activeRunId) {
      setBreakpointNodeIds([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await client.getBreakpoints(activeRunId);
        if (!cancelled) setBreakpointNodeIds(res.node_ids);
      } catch {
        /* run may not be ready yet */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeRunId, client]);

  const onToggleBreakpoint = useCallback(
    async (nodeId: string) => {
      if (!activeRunId) {
        setStatus("请先试运行后再右键切换断点");
        return;
      }
      try {
        const next = await toggleBreakpointOnServer(client, activeRunId, nodeId);
        setBreakpointNodeIds(next);
        setStatus(
          next.includes(nodeId)
            ? `已为 ${nodeId} 设置断点`
            : `已清除 ${nodeId} 断点`,
        );
      } catch (e) {
        setStatus(`断点切换失败: ${(e as Error).message}`);
      }
    },
    [activeRunId, client],
  );

  const onTemplateCloned = async (newFlowId: string) => {
    setBusy(true);
    try {
      const detail = await client.getFlow(newFlowId);
      applyLoaded(detail);
      try {
        localStorage.setItem(FLOW_ID_KEY, newFlowId);
      } catch {
        /* ignore */
      }
      setStatus(`已打开模板流程 ${detail.name}`);
    } catch (e) {
      setStatus(`打开模板流程失败: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const onUserChange = (next: string) => {
    setUserId(next);
    try {
      localStorage.setItem(USER_STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
    setStatus(`已切换用户 ${next}（${roleForUser(next)}）`);
  };

  const onAddNodeType = (typeKey: string) => {
    setGraph((g) => {
      const id = `${typeKey.toLowerCase()}_${Date.now()}`;
      return {
        ...g,
        nodes: [
          ...g.nodes,
          {
            id,
            type: typeKey,
            config:
              typeKey === "Subflow" ? { flow_version_id: "" } : {},
            ui: { x: 120 + g.nodes.length * 28, y: 120 + (g.nodes.length % 5) * 36 },
          },
        ],
      };
    });
    setGraphEpoch((n) => n + 1);
    setStatus(`已添加节点 ${typeKey}`);
  };

  const onSave = async () => {
    if (!flowId) {
      setStatus("请先创建或打开流程");
      return;
    }
    setBusy(true);
    setStatus("保存草稿…");
    try {
      const result = await client.saveDraft(flowId, graph);
      setDraftHash(result.schemaHash);
      setStatus(
        `草稿已保存 v${result.version} hash=${result.schemaHash.slice(0, 12)}…`,
      );
    } catch (e) {
      setStatus(`保存失败: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const onPublish = async () => {
    if (!flowId) {
      setStatus("请先创建或打开流程");
      return;
    }
    setBusy(true);
    setStatus("保存草稿并发布…");
    try {
      const { saved, published } = await saveThenPublish(client, flowId, graph);
      setDraftHash(saved.schemaHash);
      setPublishedVersionId(published.versionId);
      const detail = await client.getFlow(flowId);
      setPublishedVersionId(detail.publishedVersionId);
      setStatus(
        `已保存并发布 ${published.versionId}（hash=${saved.schemaHash.slice(0, 12)}…）`,
      );
    } catch (e) {
      if (e instanceof ApiError && e.body && typeof e.body === "object") {
        const body = e.body as {
          error?: string;
          checks?: { id: string; ok: boolean; message?: string }[];
        };
        if (body.error === "publish_gate_failed" && Array.isArray(body.checks)) {
          const msgs = body.checks
            .filter((c) => !c.ok)
            .map((c) => c.message ?? c.id)
            .join("; ");
          setStatus(`发布门禁失败: ${msgs || body.error}`);
        } else {
          setStatus(`发布失败: ${e.message}`);
        }
      } else {
        setStatus(`发布失败: ${(e as Error).message}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const onReload = async () => {
    if (!flowId) {
      setStatus("没有可刷新的 flowId");
      return;
    }
    await loadFlow(flowId);
  };

  const addBranch = () => {
    setGraph((g) => {
      const id = `branch_${Date.now()}`;
      return {
        ...g,
        nodes: [
          ...g.nodes,
          {
            id,
            type: "Branch",
            config: { label: "判断用户问题类型" },
            ui: { x: 200 + g.nodes.length * 24, y: 160, variant: "decision" },
          },
        ],
      };
    });
    setGraphEpoch((n) => n + 1);
    setStatus("已添加 Branch 节点（请连线 success/failure）");
  };

  const meta = useMemo(
    () =>
      [
        flowId ? `flow=${flowId}` : "flow=—",
        publishedVersionId
          ? `published=${publishedVersionId.slice(0, 12)}…`
          : "published=—",
        draftHash ? `draftHash=${draftHash.slice(0, 12)}…` : "draftHash=—",
      ].join(" · "),
    [draftHash, flowId, publishedVersionId],
  );

  return (
    <div className="awo-app">
      <header className="awo-app__header">
        <div className="awo-app__title">Workflow: {flowName}</div>
        <div className="awo-app__toolbar">
          <UserSwitcher userId={userId} onChange={onUserChange} disabled={busy} />
          <button type="button" disabled={busy} onClick={() => void onCreate()}>
            新建演示流程
          </button>
          <button type="button" disabled={busy} onClick={onLoadM2Sample}>
            载入 M2 样例
          </button>
          <button type="button" disabled={busy} onClick={onLoadM3Sample}>
            载入 M3 样例
          </button>
          <button type="button" disabled={busy} onClick={onLoadM5Sample}>
            载入 M5 样例
          </button>
          <button type="button" disabled={busy || !flowId} onClick={() => void onReload()}>
            重新加载
          </button>
          <button type="button" disabled={busy} onClick={addBranch}>
            添加 Branch
          </button>
          <button type="button" disabled={busy || !flowId} onClick={() => void onSave()}>
            保存草稿
          </button>
          <button type="button" disabled={busy || !flowId} onClick={() => void onPublish()}>
            发布
          </button>
        </div>
        <div className="awo-app__meta">{meta}</div>
        <div className="awo-app__status" role="status">
          {status}
        </div>
      </header>
      <div className="awo-app__body">
        <div className="awo-app__canvas">
          <FlowCanvas
            graph={graph}
            graphEpoch={graphEpoch}
            onGraphChange={setGraph}
            breakpointNodeIds={breakpointNodeIds}
            onSelectedNodeChange={setSelectedNodeId}
            onToggleBreakpoint={(id) => void onToggleBreakpoint(id)}
          />
        </div>
        <TestRunPanel
          flowId={flowId}
          publishedVersionId={publishedVersionId}
          graph={graph}
          client={client}
          busy={busy}
          onStatus={setStatus}
          selectedNodeId={selectedNodeId}
          breakpointNodeIds={breakpointNodeIds}
          onToggleBreakpoint={onToggleBreakpoint}
          preferM3Input
          onRunIdChange={setActiveRunId}
        />
        <aside className="awo-app__side">
          <NodePalette
            client={client}
            disabled={busy}
            onAddType={onAddNodeType}
          />
          <AssetsPanel client={client} userId={userId} onStatus={setStatus} />
          <TemplatesPanel
            client={client}
            projectId={PROJECT_ID}
            onCloned={(id) => void onTemplateCloned(id)}
            onStatus={setStatus}
          />
          <MetricsPanel
            client={client}
            flowId={flowId}
            onStatus={setStatus}
          />
        </aside>
      </div>
    </div>
  );
}
