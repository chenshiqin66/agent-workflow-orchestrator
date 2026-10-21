import { useCallback, useEffect, useMemo, useState } from "react";
import type { FlowGraph } from "@awo/graph-schema";
import { FlowCanvas } from "./canvas/FlowCanvas";
import { api } from "./api/client";
import { saveThenPublish } from "./api/save-then-publish";
import { SAMPLE_GRAPH } from "./sample-graph";
import { SAMPLE_M2_GRAPH } from "./sample-m2-graph";
import { TestRunPanel } from "./run/TestRunPanel";

const PROJECT_ID = "p_demo";
const FLOW_ID_KEY = "awo.demoFlowId";

function emptyGraph(id: string): FlowGraph {
  return {
    id,
    state_schema: { type: "object", properties: {} },
    nodes: [],
    edges: [],
  };
}

function withSampleContent(id: string): FlowGraph {
  return { ...SAMPLE_GRAPH, id };
}

function withM2Sample(id: string): FlowGraph {
  return { ...SAMPLE_M2_GRAPH, id };
}

export function App() {
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
        const detail = await api.getFlow(id);
        applyLoaded(detail);
        setStatus(`已打开「${detail.name}」`);
      } catch (e) {
        setStatus(`加载失败: ${(e as Error).message}`);
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [applyLoaded],
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
      const created = await api.createFlow(PROJECT_ID, "客服流水线");
      const seeded = withSampleContent(created.id);
      const saved = await api.saveDraft(created.id, seeded);
      const detail = await api.getFlow(created.id);
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

  const onSave = async () => {
    if (!flowId) {
      setStatus("请先创建或打开流程");
      return;
    }
    setBusy(true);
    setStatus("保存草稿…");
    try {
      const result = await api.saveDraft(flowId, graph);
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
      const { saved, published } = await saveThenPublish(api, flowId, graph);
      setDraftHash(saved.schemaHash);
      setPublishedVersionId(published.versionId);
      const detail = await api.getFlow(flowId);
      setPublishedVersionId(detail.publishedVersionId);
      setStatus(
        `已保存并发布 ${published.versionId}（hash=${saved.schemaHash.slice(0, 12)}…）`,
      );
    } catch (e) {
      setStatus(`发布失败: ${(e as Error).message}`);
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
          <button type="button" disabled={busy} onClick={() => void onCreate()}>
            新建演示流程
          </button>
          <button type="button" disabled={busy} onClick={onLoadM2Sample}>
            载入 M2 样例
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
          />
        </div>
        <TestRunPanel
          flowId={flowId}
          publishedVersionId={publishedVersionId}
          graph={graph}
          busy={busy}
          onStatus={setStatus}
        />
      </div>
    </div>
  );
}
