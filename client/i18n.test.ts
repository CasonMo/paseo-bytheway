import { describe, expect, it } from "vitest";
import { localizeServerMessage } from "./i18n";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";

function keyPaths(value: unknown, prefix = ""): string[] {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
      keyPaths(child, prefix ? `${prefix}.${key}` : key),
    );
  }
  return [prefix];
}

describe("locale resources", () => {
  it("en and zh-CN define exactly the same keys", () => {
    expect(keyPaths(en).sort()).toEqual(keyPaths(zhCN).sort());
  });

  it("every locale value is a non-empty string", () => {
    for (const resource of [en, zhCN]) {
      for (const path of keyPaths(resource)) {
        const value = path
          .split(".")
          .reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], resource);
        expect(typeof value, path).toBe("string");
        expect((value as string).length, path).toBeGreaterThan(0);
      }
    }
  });
});

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
