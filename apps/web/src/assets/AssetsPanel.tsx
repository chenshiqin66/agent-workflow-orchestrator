import { useCallback, useEffect, useState } from "react";
import type { ApiClient, KnowledgeBase, Model, Tool } from "../api/client";
import { roleForUser } from "../auth/UserSwitcher";

type Props = {
  client: ApiClient;
  userId: string;
  onStatus?: (msg: string) => void;
};

export function AssetsPanel({ client, userId, onStatus }: Props) {
  const role = roleForUser(userId);
  const canWrite = role === "developer" || role === "admin";
  const [tools, setTools] = useState<Tool[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [kbs, setKbs] = useState<KnowledgeBase[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [t, m, k] = await Promise.all([
      client.listTools(),
      client.listModels(),
      client.listKnowledgeBases(),
    ]);
    setTools(t);
    setModels(m);
    setKbs(k);
  }, [client]);

  useEffect(() => {
    void refresh().catch((e) => onStatus?.(`资产加载失败: ${(e as Error).message}`));
  }, [refresh, onStatus]);

  const onCreateTool = async () => {
    if (!canWrite) {
      onStatus?.("仅 developer/admin 可创建资产");
      return;
    }
    const n = name.trim();
    if (!n) {
      onStatus?.("请输入工具名称");
      return;
    }
    setBusy(true);
    try {
      await client.createTool({
        name: n,
        kind: "function",
        config: {},
        allowed_roles: ["builder", "developer", "admin"],
      });
      setName("");
      await refresh();
      onStatus?.(`已创建工具 ${n}`);
    } catch (e) {
      onStatus?.(`创建工具失败: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="awo-assets-panel">
      <div className="awo-assets-panel__title">资产注册表</div>
      <div className="awo-assets-panel__role">角色: {role}{canWrite ? "（可写）" : "（只读）"}</div>
      {canWrite && (
        <div className="awo-assets-panel__create">
          <input
            value={name}
            placeholder="新工具名称"
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="button" disabled={busy} onClick={() => void onCreateTool()}>
            创建 Tool
          </button>
        </div>
      )}
      <section>
        <h4>Tools ({tools.length})</h4>
        <ul>
          {tools.map((t) => (
            <li key={t.id}>
              {t.name} <span className="awo-assets-panel__muted">({t.kind})</span>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h4>Models ({models.length})</h4>
        <ul>
          {models.map((m) => (
            <li key={m.id}>
              {m.name} <span className="awo-assets-panel__muted">({m.provider})</span>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h4>Knowledge ({kbs.length})</h4>
        <ul>
          {kbs.map((k) => (
            <li key={k.id}>{k.name}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
