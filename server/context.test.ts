import { describe, expect, it } from "vitest";
import {
  buildSystemPrompt,
  chooseUnattendedMode,
  featuresToValues,
  type PaseoApi,
} from "./context";

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

describe("pickUnattendedMode", () => {
  it("优先选择 danger 级完全放行模式", () => {
    expect(
      chooseUnattendedMode([
        { id: "default", label: "Always Ask", colorTier: "safe" },
        { id: "bypassPermissions", label: "Bypass", colorTier: "dangerous" },
      ]),
    ).toBe("bypassPermissions");
  });

  it("回退到 auto / build 类可执行模式", () => {
    expect(
      chooseUnattendedMode([
        { id: "plan", label: "Plan" },
        { id: "auto", label: "Auto mode" },
      ]),
    ).toBe("auto");
    expect(
      chooseUnattendedMode([
        { id: "plan", label: "Plan" },
        { id: "build", label: "Build" },
      ]),
    ).toBe("build");
  });

  it("没有非 plan 模式时返回 undefined", () => {
    expect(chooseUnattendedMode([{ id: "plan", label: "Plan" }])).toBeUndefined();
  });
});

describe("buildSystemPrompt", () => {
  it("defers to provider permissions when no explicit provider mode is selected", () => {
    const prompt = buildSystemPrompt({
      mainAgentId: "agent-1",
      mode: "provider",
      toolsAvailable: true,
      passive: false,
    });
    expect(prompt).toContain("遵循当前 Paseo provider mode 的权限约束");
    expect(prompt).not.toContain("只读建议模式");
  });

  it("keeps an explicit plan/read-only mode explicit", () => {
    const prompt = buildSystemPrompt({
      mainAgentId: "agent-1",
      mode: "ask",
      toolsAvailable: true,
      passive: false,
    });
    expect(prompt).toContain("只读建议模式");
  });
});
