import { useCallback, useEffect, useState } from "react";
import type { ApiClient, TemplateSummary } from "../api/client";

type Props = {
  client: ApiClient;
  projectId: string;
  onCloned: (flowId: string) => void;
  onStatus?: (msg: string) => void;
};

export function TemplatesPanel({
  client,
  projectId,
  onCloned,
  onStatus,
}: Props) {
  const [items, setItems] = useState<TemplateSummary[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const list = await client.listTemplates();
    setItems(list);
  }, [client]);

  useEffect(() => {
    void refresh().catch((e) =>
      onStatus?.(`模板加载失败: ${(e as Error).message}`),
    );
  }, [refresh, onStatus]);

  const onClone = async (tpl: TemplateSummary) => {
    const name =
      typeof window !== "undefined"
        ? window.prompt("新流程名称", `${tpl.name} 副本`) ?? ""
        : `${tpl.name} 副本`;
    if (!name.trim()) return;
    setBusy(true);
    try {
      const created = await client.cloneTemplate(tpl.id, {
        project_id: projectId,
        name: name.trim(),
      });
      onStatus?.(`已从模板创建 ${created.name}`);
      onCloned(created.id);
      await refresh();
    } catch (e) {
      onStatus?.(`从模板创建失败: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="awo-m5-panel">
      <h3>模板</h3>
      <button type="button" disabled={busy} onClick={() => void refresh()}>
        刷新模板
      </button>
      <ul className="awo-m5-panel__list">
        {items.map((t) => (
          <li key={t.id}>
            <span title={t.description || t.id}>{t.name}</span>{" "}
            <button
              type="button"
              disabled={busy}
              onClick={() => void onClone(t)}
            >
              从模板创建
            </button>
          </li>
        ))}
        {items.length === 0 ? <li className="awo-m5-muted">暂无模板</li> : null}
      </ul>
    </section>
  );
}
