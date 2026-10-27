import { thinkingChoiceForModelTarget, type ThinkingChoice } from "./thinking";

export interface RememberedModelConfig {
  modeId: string | null;
  thinkingOptionId: string | null;
  featureValues: Record<string, boolean | string>;
  updatedAt: number;
}

export type RememberedModelConfigMap = Record<string, RememberedModelConfig>;

export interface EffectiveAgentConfig {
  provider: string;
  model: string;
  modeId: string | null;
  thinkingOptionId: string | null;
  featureValues: Record<string, unknown>;
}

export interface RememberedModelSelection {
  thinkingChoice: ThinkingChoice;
  modeId: string | null;
  featureValues: Record<string, boolean | string>;
}

export const MAX_REMEMBERED_MODEL_CONFIGS = 50;

function readString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, maxLength) : null;
}

export function modelConfigKey(provider: string, model: string): string | null {
  const normalizedProvider = readString(provider, 100);
  const normalizedModel = readString(model, 240);
  if (!normalizedProvider || !normalizedModel) return null;
  return `${normalizedProvider}/${normalizedModel}`;
}

export function sanitizeFeatureValues(
  values: unknown,
): Record<string, boolean | string> {
  if (!values || typeof values !== "object" || Array.isArray(values)) return {};
  const output: Record<string, boolean | string> = {};
  for (const [rawKey, rawValue] of Object.entries(values).slice(0, 50)) {
    const key = readString(rawKey, 100);
    if (!key) continue;
    if (typeof rawValue === "boolean") {
      output[key] = rawValue;
    } else if (typeof rawValue === "string" && rawValue.length <= 2_000) {
      output[key] = rawValue;
    }
  }
  return output;
}

export function sanitizeRememberedModelConfig(
  input: unknown,
): RememberedModelConfig | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const updatedAt =
    typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt) && record.updatedAt > 0
      ? Math.trunc(record.updatedAt)
      : Date.now();
  return {
    modeId: readString(record.modeId, 200),
    thinkingOptionId: readString(record.thinkingOptionId, 200),
    featureValues: sanitizeFeatureValues(record.featureValues),
    updatedAt,
  };
}

export function sanitizeRememberedModelConfigMap(
  input: unknown,
  max = MAX_REMEMBERED_MODEL_CONFIGS,
): RememberedModelConfigMap {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  let output: RememberedModelConfigMap = {};
  for (const [rawKey, rawConfig] of Object.entries(input)) {
    const key = readString(rawKey, 400);
    if (!key) continue;
    const config = sanitizeRememberedModelConfig(rawConfig);
    if (!config) continue;
    output = upsertRememberedModelConfig(output, key, config, max);
  }
  return output;
}

export function upsertRememberedModelConfig(
  configs: RememberedModelConfigMap,
  key: string,
  config: RememberedModelConfig,
  max = MAX_REMEMBERED_MODEL_CONFIGS,
): RememberedModelConfigMap {
  const next = { ...configs, [key]: config };
  const entries = Object.entries(next);
  if (entries.length <= max) return next;
  entries
    .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
    .slice(max)
    .forEach(([expiredKey]) => {
      delete next[expiredKey];
    });
  return next;
}

export function resolveRememberedModelConfig(
  saved: RememberedModelConfig | undefined,
  thinkingOptions: ReadonlyArray<{ id: string }>,
  matchesMain: boolean,
): RememberedModelSelection | null {
  if (!saved) return null;
  const savedThinking = saved.thinkingOptionId;
  let thinkingChoice: ThinkingChoice;
  if (savedThinking === null) {
    thinkingChoice = { mode: "option", id: null };
  } else if (thinkingOptions.some((option) => option.id === savedThinking)) {
    thinkingChoice = { mode: "option", id: savedThinking };
  } else {
    thinkingChoice = thinkingChoiceForModelTarget(matchesMain);
  }
  return {
    thinkingChoice,
    modeId: saved.modeId,
    featureValues: saved.featureValues,
  };
}
