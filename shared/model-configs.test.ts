import { describe, expect, it } from "vitest";
import {
  MAX_REMEMBERED_MODEL_CONFIGS,
  modelConfigKey,
  resolveRememberedModelConfig,
  sanitizeRememberedModelConfig,
  sanitizeRememberedModelConfigMap,
  upsertRememberedModelConfig,
  type RememberedModelConfig,
} from "./model-configs";

function config(updatedAt: number): RememberedModelConfig {
  return {
    modeId: "build",
    thinkingOptionId: "high",
    featureValues: { auto_accept: true },
    updatedAt,
  };
}

describe("model config keys", () => {
  it("keeps provider as the first segment and allows slashes in model ids", () => {
    expect(modelConfigKey(" codex ", " backup/ZHIPU/GLM-5.3-Flash ")).toBe(
      "codex/backup/ZHIPU/GLM-5.3-Flash",
    );
    expect(modelConfigKey("", "model")).toBeNull();
  });
});

describe("model config sanitization", () => {
  it("keeps only JSON-safe feature values and trims ids", () => {
    expect(
      sanitizeRememberedModelConfig({
        modeId: " full-access ",
        thinkingOptionId: " high ",
        featureValues: {
          auto_accept: true,
          plan_mode: false,
          variant: "fast",
          nested: { value: 1 },
          number: 3,
        },
        updatedAt: 123,
      }),
    ).toEqual({
      modeId: "full-access",
      thinkingOptionId: "high",
      featureValues: { auto_accept: true, plan_mode: false, variant: "fast" },
      updatedAt: 123,
    });
  });

  it("validates maps and prunes the oldest entries", () => {
    const input: Record<string, unknown> = {};
    for (let index = 0; index < MAX_REMEMBERED_MODEL_CONFIGS + 3; index += 1) {
      input[`provider/model-${index}`] = config(index + 1);
    }
    const map = sanitizeRememberedModelConfigMap(input);
    expect(Object.keys(map)).toHaveLength(MAX_REMEMBERED_MODEL_CONFIGS);
    expect(map["provider/model-0"]).toBeUndefined();
    expect(map[`provider/model-${MAX_REMEMBERED_MODEL_CONFIGS + 2}`]).toBeDefined();
  });

  it("updates an existing key instead of adding a duplicate", () => {
    const next = upsertRememberedModelConfig(
      { "p/m": config(1) },
      "p/m",
      { ...config(2), thinkingOptionId: "max" },
    );
    expect(Object.keys(next)).toEqual(["p/m"]);
    expect(next["p/m"]?.thinkingOptionId).toBe("max");
  });
});

describe("remembered model selection", () => {
  it("restores a valid thinking option", () => {
    expect(
      resolveRememberedModelConfig(
        config(1),
        [{ id: "high" }, { id: "max" }],
        false,
      ),
    ).toMatchObject({
      thinkingChoice: { mode: "option", id: "high" },
      modeId: "build",
      featureValues: { auto_accept: true },
    });
  });

  it("falls back when the saved thinking option no longer exists", () => {
    expect(
      resolveRememberedModelConfig(
        { ...config(1), thinkingOptionId: "removed" },
        [{ id: "high" }],
        false,
      )?.thinkingChoice,
    ).toEqual({ mode: "option", id: null });
  });

  it("returns null when the model has no memory", () => {
    expect(resolveRememberedModelConfig(undefined, [], false)).toBeNull();
  });
});
