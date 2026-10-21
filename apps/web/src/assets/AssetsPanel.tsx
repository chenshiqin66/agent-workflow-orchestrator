import { useCallback, useEffect, useState } from "react";
import type { ApiClient, KnowledgeBase, Model, Tool } from "../api/client";
import { roleForUser } from "../auth/UserSwitcher";
import { parseAssetConfigJson } from "./parseAssetConfig";

type Props = {
  client: ApiClient;
  userId: string;
  onStatus?: (msg: string) => void;
};

type AssetKind = "tool" | "model" | "kb";

export function AssetsPanel({ client, userId, onStatus }: Props) {
  const role = roleForUser(userId);
  const canWrite = role === "developer" || role === "admin";
  const [tools, setTools] = useState<Tool[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [kbs, setKbs] = useState<KnowledgeBase[]>([]);
  const [assetKind, setAssetKind] = useState<AssetKind>("tool");
  const [name, setName] = useState("");
  const [toolKind, setToolKind] = useState("function");
  const [provider, setProvider] = useState("stub");
  const [configText, setConfigText] = useState("{}");
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

  const resetForm = () => {
    setName("");
    setToolKind("function");
    setProvider("stub");
    setConfigText("{}");
  };

  const onCreate = async () => {
    if (!canWrite) {
      onStatus?.("仅 developer/admin 可创建资产");
      return;
    }
    const n = name.trim();
    if (!n) {
      onStatus?.("请输入名称");
      return;
    }
    const parsed = parseAssetConfigJson(configText);
    if (!parsed.ok) {
      onStatus?.(parsed.error);
      return;
    }
    setBusy(true);
    try {
      if (assetKind === "tool") {
        await client.createTool({
          name: n,
          kind: toolKind.trim() || "function",
          config: parsed.value,
          allowed_roles: ["builder", "developer", "admin"],
        });
        onStatus?.(`已创建工具 ${n}`);
      } else if (assetKind === "model") {
        await client.createModel({
          name: n,
          provider: provider.trim() || "stub",
          config: parsed.value,
        });
        onStatus?.(`已创建模型 ${n}`);
      } else {
        await client.createKnowledgeBase({
          name: n,
          config: parsed.value,
        });
        onStatus?.(`已创建知识库 ${n}`);
      }
      resetForm();
      await refresh();
    } catch (e) {
      onStatus?.(`创建失败: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const onDeleteTool = async (id: string, label: string) => {
    if (!canWrite) return;
    setBusy(true);
    try {
      await client.deleteTool(id);
      await refresh();
      onStatus?.(`已删除工具 ${label}`);
    } catch (e) {
      onStatus?.(`删除失败: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const onDeleteModel = async (id: string, label: string) => {
    if (!canWrite) return;
    setBusy(true);
    try {
      await client.deleteModel(id);
      await refresh();
      onStatus?.(`已删除模型 ${label}`);
    } catch (e) {
      onStatus?.(`删除失败: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const onDeleteKb = async (id: string, label: string) => {
    if (!canWrite) return;
    setBusy(true);
    try {
      await client.deleteKnowledgeBase(id);
      await refresh();
      onStatus?.(`已删除知识库 ${label}`);
    } catch (e) {
      onStatus?.(`删除失败: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="awo-assets-panel">
      <div className="awo-assets-panel__title">资产注册表</div>
      <div className="awo-assets-panel__role">
        角色: {role}
        {canWrite ? "（可写）" : "（只读）"}
      </div>
      {canWrite && (
        <div className="awo-assets-panel__form">
          <div className="awo-assets-panel__create">
            <select
              value={assetKind}
              disabled={busy}
              aria-label="资产类型"
              onChange={(e) => setAssetKind(e.target.value as AssetKind)}
            >
              <option value="tool">Tool</option>
              <option value="model">Model</option>
              <option value="kb">Knowledge</option>
            </select>
            <input
              value={name}
              placeholder="名称"
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          {assetKind === "tool" && (
            <div className="awo-assets-panel__create">
              <input
                value={toolKind}
                placeholder="kind (function/http/…)"
                disabled={busy}
                onChange={(e) => setToolKind(e.target.value)}
              />
            </div>
          )}
          {assetKind === "model" && (
            <div className="awo-assets-panel__create">
              <input
                value={provider}
                placeholder="provider"
                disabled={busy}
                onChange={(e) => setProvider(e.target.value)}
              />
            </div>
          )}
          <label className="awo-assets-panel__config-label">
            JSON config
            <textarea
              className="awo-assets-panel__config"
              value={configText}
              disabled={busy}
              rows={3}
              spellCheck={false}
              onChange={(e) => setConfigText(e.target.value)}
            />
          </label>
          <button type="button" disabled={busy} onClick={() => void onCreate()}>
            创建
          </button>
        </div>
      )}
      <section>
        <h4>Tools ({tools.length})</h4>
        <ul>
          {tools.map((t) => (
            <li key={t.id}>
              <span>
                {t.name}{" "}
                <span className="awo-assets-panel__muted">({t.kind})</span>
              </span>
              {canWrite && (
                <button
                  type="button"
                  className="awo-assets-panel__delete"
                  disabled={busy}
                  onClick={() => void onDeleteTool(t.id, t.name)}
                >
                  删除
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h4>Models ({models.length})</h4>
        <ul>
          {models.map((m) => (
            <li key={m.id}>
              <span>
                {m.name}{" "}
                <span className="awo-assets-panel__muted">({m.provider})</span>
              </span>
              {canWrite && (
                <button
                  type="button"
                  className="awo-assets-panel__delete"
                  disabled={busy}
                  onClick={() => void onDeleteModel(m.id, m.name)}
                >
                  删除
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h4>Knowledge ({kbs.length})</h4>
        <ul>
          {kbs.map((k) => (
            <li key={k.id}>
              <span>{k.name}</span>
              {canWrite && (
                <button
                  type="button"
                  className="awo-assets-panel__delete"
                  disabled={busy}
                  onClick={() => void onDeleteKb(k.id, k.name)}
                >
                  删除
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
