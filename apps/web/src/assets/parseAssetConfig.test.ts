import { describe, expect, it } from "vitest";
import { parseAssetConfigJson } from "./parseAssetConfig";

describe("parseAssetConfigJson", () => {
  it("empty → {}", () => {
    expect(parseAssetConfigJson("")).toEqual({ ok: true, value: {} });
    expect(parseAssetConfigJson("  \n")).toEqual({ ok: true, value: {} });
  });

  it("parses object", () => {
    expect(parseAssetConfigJson('{"a":1}')).toEqual({
      ok: true,
      value: { a: 1 },
    });
  });

  it("rejects array / scalar / invalid", () => {
    expect(parseAssetConfigJson("[]").ok).toBe(false);
    expect(parseAssetConfigJson('"x"').ok).toBe(false);
    expect(parseAssetConfigJson("{").ok).toBe(false);
  });
});
