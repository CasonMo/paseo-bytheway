import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  modelConfigKey,
  sanitizeRememberedModelConfig,
  sanitizeRememberedModelConfigMap,
  upsertRememberedModelConfig,
  type RememberedModelConfig,
  type RememberedModelConfigMap,
} from "../shared/model-configs";

interface PersistedState {
  version: 1;
  configs: RememberedModelConfigMap;
}

const dir = join(homedir(), ".paseo", "plugin-data", "paseo-bytheway");
const file = join(dir, "model-configs.json");
const SAVE_DEBOUNCE_MS = 300;

let records: RememberedModelConfigMap = {};
let loadedPromise: Promise<void> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function ensureLoaded(): Promise<void> {
  loadedPromise ??= (async () => {
    try {
      const raw = await readFile(file, "utf8");
      const parsed = JSON.parse(raw) as PersistedState;
      if (!parsed || parsed.version !== 1) return;
      records = sanitizeRememberedModelConfigMap(parsed.configs);
    } catch {
      // First run or damaged data: start empty.
    }
  })();
  return loadedPromise;
}

export function listModelConfigs(): RememberedModelConfigMap {
  return { ...records };
}

export async function rememberModelConfig(
  provider: string,
  model: string,
  config: {
    modeId: string | null;
    thinkingOptionId: string | null;
    featureValues: Record<string, unknown>;
    updatedAt?: number;
  },
): Promise<void> {
  await ensureLoaded();
  const key = modelConfigKey(provider, model);
  if (!key) return;
  const sanitized = sanitizeRememberedModelConfig({
    ...config,
    updatedAt: config.updatedAt ?? Date.now(),
  });
  if (!sanitized) return;
  records = upsertRememberedModelConfig(records, key, sanitized);
  scheduleSave();
}

function snapshot(): PersistedState {
  return { version: 1, configs: records };
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void flushSave();
  }, SAVE_DEBOUNCE_MS);
}

export async function flushSave(): Promise<void> {
  if (!loadedPromise) return;
  await loadedPromise;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    await mkdir(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(snapshot()), "utf8");
    await rename(tmp, file);
  } catch (error) {
    console.error("[bytheway] failed to persist model configs", error);
  }
}
