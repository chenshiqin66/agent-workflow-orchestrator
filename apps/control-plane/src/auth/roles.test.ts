import { describe, it, expect } from "vitest";
import { roleAtLeast, parseRole } from "./roles";

describe("roleAtLeast", () => {
  it("developer sees builder-min nodes", () => {
    expect(roleAtLeast("developer", "builder")).toBe(true);
  });
  it("builder does not see developer-min nodes", () => {
    expect(roleAtLeast("builder", "developer")).toBe(false);
  });
  it("unknown role denies", () => {
    expect(roleAtLeast("nope", "viewer")).toBe(false);
  });
  it("parseRole accepts admin", () => {
    expect(parseRole("admin")).toBe("admin");
  });
});
