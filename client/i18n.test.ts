import { describe, expect, it } from "vitest";
import { localizeServerMessage } from "./i18n";

describe("localizeServerMessage", () => {
  it("translates runtime control failures into actionable English", () => {
    expect(localizeServerMessage("运行配置切换失败：未知原因", "en")).toContain("Agent settings switch failed");
    expect(localizeServerMessage("思考档切换未生效（当前仍是 low）", "en")).toContain("Thinking level switch failed");
    expect(localizeServerMessage("功能项 plan_mode 切换未生效", "en")).toContain("Feature switch failed");
    expect(localizeServerMessage("模式切换未生效（当前仍是 auto）", "en")).toContain("Mode switch failed");
  });

  it("leaves Chinese messages unchanged", () => {
    const message = "运行配置切换失败：未知原因";
    expect(localizeServerMessage(message, "zh-CN")).toBe(message);
  });
});
