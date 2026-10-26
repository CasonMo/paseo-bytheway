import { describe, expect, it } from "vitest";
import {
  defaultProviderModeId,
  featureDefaults,
  inheritedProviderModeId,
  mergeFeatureDefaults,
  sameFeatureValues,
  sanitizeFeatureValues,
  snapshotFeatureValues,
  threadModeForProviderMode,
} from "./controls";

describe("featureDefaults", () => {
  it("collects current values from generic toggle and select settings", () => {
    expect(
      featureDefaults([
        { type: "toggle", id: "auto_accept", label: "Auto Accept", value: true },
        {
          type: "select",
          id: "speed",
          label: "Speed",
          value: "fast",
          options: [
            { id: "normal", label: "Normal" },
            { id: "fast", label: "Fast" },
          ],
        },
      ]),
    ).toEqual({ auto_accept: true, speed: "fast" });
  });
});

describe("mergeFeatureDefaults", () => {
  it("fills missing provider defaults without overriding user values", () => {
    expect(
      mergeFeatureDefaults(
        { auto_accept: false },
        [
          { type: "toggle", id: "auto_accept", label: "Auto Accept", value: true },
          { type: "toggle", id: "plan_mode", label: "Plan", value: false },
        ],
      ),
    ).toEqual({ auto_accept: false, plan_mode: false });
  });
});

describe("threadModeForProviderMode", () => {
  it("maps planning/read-only modes to the legacy ask bucket", () => {
    expect(threadModeForProviderMode({ id: "plan", label: "Plan", colorTier: "planning" })).toBe("ask");
    expect(threadModeForProviderMode({ id: "readonly", label: "Read-only" })).toBe("ask");
  });

  it("maps executable modes to the legacy work bucket", () => {
    expect(threadModeForProviderMode({ id: "build", label: "Build", colorTier: "moderate" })).toBe("work");
    expect(threadModeForProviderMode({ id: "full-access", label: "Full Access", colorTier: "dangerous" })).toBe("work");
  });

  it("defaults to work when no mode is available", () => {
    expect(threadModeForProviderMode(undefined)).toBe("work");
  });
});

describe("snapshotFeatureValues", () => {
  it("extracts configured values from agent feature snapshots", () => {
    expect(
      snapshotFeatureValues([
        { id: "auto_accept", value: true },
        { id: "mode", value: "fast" },
        { id: "unset", value: null },
      ]),
    ).toEqual({ auto_accept: true, mode: "fast" });
  });
});

describe("sameFeatureValues", () => {
  it("compares supported primitive feature maps", () => {
    expect(sameFeatureValues({ a: true, b: "fast" }, { b: "fast", a: true })).toBe(true);
    expect(sameFeatureValues({ a: true }, { a: false })).toBe(false);
    expect(sameFeatureValues({ a: true }, { a: true, b: false })).toBe(false);
  });
});

describe("inheritedProviderModeId", () => {
  it("inherits the main session mode when provider and model match", () => {
    expect(
      inheritedProviderModeId("codex", "deepseek-v4.1-flash", {
        provider: "codex",
        model: "deepseek-v4.1-flash",
        currentModeId: "auto-review",
      }),
    ).toBe("auto-review");
  });

  it("uses provider default when the model differs", () => {
    expect(
      inheritedProviderModeId("codex", "deepseek-v4.1-flash-1017", {
        provider: "codex",
        model: "deepseek-v4.1-flash",
        currentModeId: "auto-review",
      }),
    ).toBeNull();
  });
});

describe("sanitizeFeatureValues", () => {
  const features = [
    { type: "toggle" as const, id: "plan_mode", label: "Plan", value: false },
    {
      type: "select" as const,
      id: "speed",
      label: "Speed",
      value: "normal",
      options: [
        { id: "normal", label: "Normal" },
        { id: "fast", label: "Fast" },
      ],
    },
  ];

  it("keeps only supported keys with valid toggle/select values", () => {
    expect(
      sanitizeFeatureValues(
        {
          plan_mode: true,
          speed: "fast",
          unknown: "drop-me",
        },
        features,
      ),
    ).toEqual({ plan_mode: true, speed: "fast" });
  });

  it("drops wrong types and values outside select options", () => {
    expect(sanitizeFeatureValues({ plan_mode: "yes", speed: "warp" }, features)).toEqual({});
  });
});

describe("mergeFeatureDefaults compatibility pruning", () => {
  it("drops keys that no longer exist in the current provider catalog", () => {
    expect(
      mergeFeatureDefaults(
        { plan_mode: true, stale_feature: "old" },
        [{ type: "toggle", id: "plan_mode", label: "Plan", value: false }],
      ),
    ).toEqual({ plan_mode: true });
  });
});

describe("defaultProviderModeId", () => {
  it("prefers a default/safe mode", () => {
    expect(
      defaultProviderModeId([
        { id: "plan", label: "Plan", colorTier: "planning" },
        { id: "default", label: "Default", colorTier: "safe" },
      ]),
    ).toBe("default");
  });

  it("prefers build for execution providers", () => {
    expect(
      defaultProviderModeId([
        { id: "plan", label: "Plan", colorTier: "planning" },
        { id: "build", label: "Build", colorTier: "moderate" },
      ]),
    ).toBe("build");
  });

  it("falls back to the first non-plan mode", () => {
    expect(
      defaultProviderModeId([
        { id: "plan", label: "Plan", colorTier: "planning" },
        { id: "auto", label: "Default Permissions", colorTier: "moderate" },
        { id: "full-access", label: "Full Access", colorTier: "dangerous" },
      ]),
    ).toBe("auto");
  });

  it("returns null when the provider exposes no modes", () => {
    expect(defaultProviderModeId([])).toBeNull();
  });
});
