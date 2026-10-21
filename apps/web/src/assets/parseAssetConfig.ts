/** Parse optional JSON config textarea. Empty → {}. Rejects non-objects. */
export function parseAssetConfigJson(raw: string):
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: {} };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return { ok: false, error: "config 必须是 JSON 对象" };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, error: "config JSON 无效" };
  }
}
