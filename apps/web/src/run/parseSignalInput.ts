/** Parse SignalPanel Input JSON: must be a plain object (not array/scalar). */
export function parseSignalInputPayload(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("输入必须是合法 JSON 对象");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    throw new Error("输入必须是 JSON 对象");
  }
  return parsed as Record<string, unknown>;
}
