import type { ThreadMode } from "./contracts";

export interface ProviderModeLike {
  id: string;
  label: string;
  description?: string;
  colorTier?: string;
}

export type ProviderFeatureLike =
  | {
      type: "toggle";
      id: string;
      label: string;
      description?: string;
      tooltip?: string;
      icon?: string;
      value: boolean;
    }
  | {
      type: "select";
      id: string;
      label: string;
      description?: string;
      tooltip?: string;
      icon?: string;
      value: string | null;
      options: ReadonlyArray<{
        id: string;
        label: string;
        description?: string;
        isDefault?: boolean;
        metadata?: Readonly<Record<string, unknown>>;
      }>;
    };

export function featureDefaults(features: readonly ProviderFeatureLike[]): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const feature of features) {
    if (feature.value !== null && feature.value !== undefined) values[feature.id] = feature.value;
  }
  return values;
}

export function mergeFeatureDefaults(
  current: Record<string, unknown>,
  features: readonly ProviderFeatureLike[],
): Record<string, unknown> {
  return { ...featureDefaults(features), ...sanitizeFeatureValues(current, features) };
}

/** Paseo 原生 mode 与旧注册表并发桶之间的兼容映射；不用于 UI 展示。 */
export function threadModeForProviderMode(mode: ProviderModeLike | undefined): ThreadMode {
  if (!mode) return "work";
  const text = `${mode.id} ${mode.label}`;
  return mode.colorTier === "planning" || /plan|read.?only|read-only/i.test(text) ? "ask" : "work";
}

/** 从 Paseo agent.features 快照提取可回写的原始值。 */
export function snapshotFeatureValues(
  features: ReadonlyArray<{ id: string; value?: boolean | string | null }> | null | undefined,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const feature of features ?? []) {
    if (feature.value !== null && feature.value !== undefined) values[feature.id] = feature.value;
  }
  return values;
}

export function sameFeatureValues(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (!Object.is(left[key], right[key])) return false;
  }
  return true;
}

export function inheritedProviderModeId(
  provider: string,
  model: string,
  main: { provider: string; model: string | null; currentModeId?: string | null },
): string | null {
  if (provider !== main.provider || model !== (main.model ?? "")) return null;
  return main.currentModeId ?? null;
}

export function sanitizeFeatureValues(
  requested: Record<string, unknown>,
  features: readonly ProviderFeatureLike[],
): Record<string, unknown> {
  const allowed = new Map(features.map((feature) => [feature.id, feature]));
  const sanitized: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(requested)) {
    const feature = allowed.get(id);
    if (!feature) continue;
    if (feature.type === "toggle" && typeof value === "boolean") {
      sanitized[id] = value;
    } else if (
      feature.type === "select" &&
      typeof value === "string" &&
      feature.options.some((option) => option.id === value)
    ) {
      sanitized[id] = value;
    }
  }
  return sanitized;
}

export function defaultProviderModeId(modes: readonly ProviderModeLike[]): string | null {
  const explicitDefault = modes.find((mode) => /(^|[-_\s])default($|[-_\s])/i.test(`${mode.id} ${mode.label}`));
  if (explicitDefault) return explicitDefault.id;
  const safe = modes.find((mode) => mode.colorTier === "safe");
  if (safe) return safe.id;
  const build = modes.find((mode) => /build|code|exec/i.test(`${mode.id} ${mode.label}`));
  if (build) return build.id;
  return modes.find((mode) => mode.colorTier !== "planning" && !/plan|read.?only|read-only/i.test(`${mode.id} ${mode.label}`))?.id
    ?? modes[0]?.id
    ?? null;
}
