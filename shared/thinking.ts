export interface ThinkingSource {
  provider: string;
  model: string | null;
  thinkingOptionId?: string | null;
  effectiveThinkingOptionId?: string | null;
}

/** 同 provider/model 时继承主会话当前生效的思考档；模型不一致时使用目标模型默认档。 */
export function inheritedThinkingOptionId(
  provider: string,
  model: string,
  main: ThinkingSource,
): string | null {
  if (provider !== main.provider || model !== (main.model ?? "")) return null;
  return main.effectiveThinkingOptionId ?? main.thinkingOptionId ?? null;
}

/** undefined=沿用 fallback；null=显式回到模型默认；string=固定档位。 */
export function resolveRequestedThinkingOptionId(
  requested: string | null | undefined,
  fallback: string | null,
): string | null {
  return requested === undefined ? fallback : requested;
}

export type ThinkingChoice =
  | { mode: "follow" }
  | { mode: "option"; id: string | null };

/**
 * 把 UI 选择转成 threads.ask/rebuild 的 thinkingOptionId。
 * - 新线程 follow：不传，让服务端在发送时读取主会话最新值；
 * - 已有线程 follow：解析成主会话当前值（模型不同则回到模型默认）；
 * - 与当前线程值一致：不传，避免无意义的辅助 agent 切换。
 */
export function resolveThinkingRequest(
  choice: ThinkingChoice,
  mainThinkingOptionId: string | null,
  targetMatchesMain: boolean,
  currentThreadThinkingOptionId: string | null | undefined,
): string | null | undefined {
  if (currentThreadThinkingOptionId === undefined && choice.mode === "follow") return undefined;
  const desired = choice.mode === "follow" ? (targetMatchesMain ? mainThinkingOptionId : null) : choice.id;
  if (currentThreadThinkingOptionId !== undefined && desired === currentThreadThinkingOptionId) {
    return undefined;
  }
  return desired;
}

/** 用户切换目标模型时，重置为该目标对应的默认选择。 */
export function thinkingChoiceForModelTarget(targetMatchesMain: boolean): ThinkingChoice {
  return targetMatchesMain ? { mode: "follow" } : { mode: "option", id: null };
}
