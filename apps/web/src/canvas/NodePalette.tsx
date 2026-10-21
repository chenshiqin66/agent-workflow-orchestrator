import { useEffect, useState } from "react";
import type { ApiClient, NodeDef } from "../api/client";

type Props = {
  client: ApiClient;
  onAddType: (typeKey: string) => void;
  disabled?: boolean;
};

export function NodePalette({ client, onAddType, disabled }: Props) {
  const [defs, setDefs] = useState<NodeDef[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows = await client.listNodeDefs();
        if (!cancelled) {
          setDefs(rows);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  return (
    <div className="awo-node-palette">
      <div className="awo-node-palette__title">节点（按角色过滤）</div>
      {error && <div className="awo-node-palette__error">{error}</div>}
      <div className="awo-node-palette__list">
        {defs.map((d) => (
          <button
            key={d.id}
            type="button"
            disabled={disabled}
            title={`min_role=${d.minRole}`}
            onClick={() => onAddType(d.typeKey)}
          >
            {d.typeKey}
          </button>
        ))}
      </div>
    </div>
  );
}
