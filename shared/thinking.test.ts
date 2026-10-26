import { describe, expect, it } from "vitest";
import {
  inheritedThinkingOptionId,
  resolveRequestedThinkingOptionId,
  resolveThinkingRequest,
  thinkingChoiceForModelTarget,
} from "./thinking";

const main = {
  provider: "codex",
  model: "gpt-5.5",
  thinkingOptionId: "high",
  effectiveThinkingOptionId: "max",
};

describe("inheritedThinkingOptionId", () => {
  it("follows the main session's effective thinking option for the same provider and model", () => {
    expect(inheritedThinkingOptionId("codex", "gpt-5.5", main)).toBe("max");
  });

  it("uses the configured thinking option when no effective option is available", () => {
    expect(
      inheritedThinkingOptionId("codex", "gpt-5.5", {
        provider: "codex",
        model: "gpt-5.5",
        thinkingOptionId: "high",
        effectiveThinkingOptionId: null,
      }),
    ).toBe("high");
  });

  it("does not copy a thinking option across models", () => {
    expect(inheritedThinkingOptionId("codex", "gpt-5.6", main)).toBeNull();
    expect(inheritedThinkingOptionId("claude", "gpt-5.5", main)).toBeNull();
  });
});

describe("resolveRequestedThinkingOptionId", () => {
  it("keeps the current option when the request omits a value", () => {
    expect(resolveRequestedThinkingOptionId(undefined, "high")).toBe("high");
    expect(resolveRequestedThinkingOptionId(undefined, null)).toBeNull();
  });

  it("clears to the model default when null is explicitly requested", () => {
    expect(resolveRequestedThinkingOptionId(null, "high")).toBeNull();
  });

  it("uses an explicit option id instead of the current option", () => {
    expect(resolveRequestedThinkingOptionId("low", "high")).toBe("low");
  });
});

describe("resolveThinkingRequest", () => {
  it("omits a new-thread follow request so the server can inherit the latest main value", () => {
    expect(resolveThinkingRequest({ mode: "follow" }, "max", true, undefined)).toBeUndefined();
  });

  it("sends the main value when following an existing thread that is out of sync", () => {
    expect(resolveThinkingRequest({ mode: "follow" }, "max", true, "low")).toBe("max");
  });

  it("uses the target model default for follow when models differ", () => {
    expect(resolveThinkingRequest({ mode: "follow" }, "max", false, "low")).toBeNull();
  });

  it("omits an existing-thread request when the resolved value is unchanged", () => {
    expect(resolveThinkingRequest({ mode: "follow" }, "max", true, "max")).toBeUndefined();
    expect(resolveThinkingRequest({ mode: "option", id: "low" }, "max", true, "low")).toBeUndefined();
  });

  it("sends an explicit option when it differs from the current thread value", () => {
    expect(resolveThinkingRequest({ mode: "option", id: "low" }, "max", true, "high")).toBe("low");
    expect(resolveThinkingRequest({ mode: "option", id: null }, "max", true, "high")).toBeNull();
  });
});

describe("thinkingChoiceForModelTarget", () => {
  it("follows main when the newly selected model matches the main session", () => {
    expect(thinkingChoiceForModelTarget(true)).toEqual({ mode: "follow" });
  });

  it("resets to the new model default when the selected model differs from main", () => {
    expect(thinkingChoiceForModelTarget(false)).toEqual({ mode: "option", id: null });
  });
});
