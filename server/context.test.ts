import { describe, expect, it } from "vitest";
import { featuresToValues, pickBuildMode, type PaseoApi } from "./context";

describe("featuresToValues", () => {
  it("提取 toggle/select 的值并跳过未设置的项", () => {
    const values = featuresToValues([
      { id: "auto_accept", value: true },
      { id: "some_select", value: "high" },
      { id: "unset_select", value: null },
    ]);
    expect(values).toEqual({ auto_accept: true, some_select: "high" });
  });

  it("容忍空输入", () => {
    expect(featuresToValues(undefined)).toEqual({});
    expect(featuresToValues(null)).toEqual({});
    expect(featuresToValues([])).toEqual({});
  });
});

function paseoWithModes(modes: Array<{ id: string; label: string }>): PaseoApi {
  return { providers: { listModes: async () => ({ modes }) } } as unknown as PaseoApi;
}

describe("pickBuildMode", () => {
  it("优先匹配 build/code/exec 模式的 id 或 label", async () => {
    const paseo = paseoWithModes([
      { id: "plan", label: "Plan" },
      { id: "build", label: "Build" },
    ]);
    expect(await pickBuildMode(paseo, "opencode")).toBe("build");
  });

  it("无匹配时回退到第一个非 plan/read 模式", async () => {
    const paseo = paseoWithModes([
      { id: "plan", label: "Plan" },
      { id: "readonly", label: "Read only" },
      { id: "default", label: "Always Ask" },
    ]);
    expect(await pickBuildMode(paseo, "claude")).toBe("default");
  });

  it("全是 plan/read 模式时返回 undefined", async () => {
    const paseo = paseoWithModes([
      { id: "plan", label: "Plan" },
      { id: "read", label: "Read" },
    ]);
    expect(await pickBuildMode(paseo, "x")).toBeUndefined();
  });

  it("listModes 失败时返回 undefined", async () => {
    const paseo = {
      providers: {
        listModes: async () => {
          throw new Error("offline");
        },
      },
    } as unknown as PaseoApi;
    expect(await pickBuildMode(paseo, "x")).toBeUndefined();
  });
});