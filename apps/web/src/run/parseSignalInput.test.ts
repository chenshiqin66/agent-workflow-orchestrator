import { describe, it, expect } from "vitest";
import { parseSignalInputPayload } from "./parseSignalInput";

describe("parseSignalInputPayload", () => {
  it("accepts plain objects", () => {
    expect(parseSignalInputPayload('{"a":1}')).toEqual({ a: 1 });
    expect(parseSignalInputPayload("{}")).toEqual({});
  });

  it("rejects arrays, scalars, and invalid JSON", () => {
    expect(() => parseSignalInputPayload("[]")).toThrow(/JSON 对象/);
    expect(() => parseSignalInputPayload('"x"')).toThrow(/JSON 对象/);
    expect(() => parseSignalInputPayload("1")).toThrow(/JSON 对象/);
    expect(() => parseSignalInputPayload("null")).toThrow(/JSON 对象/);
    expect(() => parseSignalInputPayload("{")).toThrow(/合法 JSON/);
  });
});
