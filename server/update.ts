import { isNewer, PLUGIN_VERSION } from "../shared/meta";

const CACHE_MS = 60 * 60 * 1000;
const RAW = "https://raw.githubusercontent.com/CasonMo/paseo-bytheway/main";

let cache: { at: number; latest: string; requiredPaseo: string | null } | null = null;

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`${url} ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 从 GitHub main 读取最新 package.json / paseo-plugin.json。
 * 网络失败时静默返回无更新（横幅不打扰用户）。
 */
export async function checkUpdate(): Promise<{
  updateAvailable: boolean;
  current: string;
  latest: string | null;
  requiredPaseo: string | null;
}> {
  if (cache && Date.now() - cache.at < CACHE_MS) {
    return {
      updateAvailable: isNewer(cache.latest, PLUGIN_VERSION),
      current: PLUGIN_VERSION,
      latest: cache.latest,
      requiredPaseo: cache.requiredPaseo,
    };
  }
  try {
    const [pkg, manifest] = await Promise.all([
      fetchJson(`${RAW}/package.json`) as Promise<{ version?: unknown }>,
      fetchJson(`${RAW}/paseo-plugin.json`) as Promise<{ requirements?: { paseo?: unknown } }>,
    ]);
    const latest = typeof pkg.version === "string" && pkg.version ? pkg.version : null;
    if (!latest) throw new Error("missing version");
    const required = manifest.requirements?.paseo;
    const requiredPaseo = typeof required === "string" && required ? required : null;
    cache = { at: Date.now(), latest, requiredPaseo };
  } catch {
    return { updateAvailable: false, current: PLUGIN_VERSION, latest: null, requiredPaseo: null };
  }
  return {
    updateAvailable: isNewer(cache.latest, PLUGIN_VERSION),
    current: PLUGIN_VERSION,
    latest: cache.latest,
    requiredPaseo: cache.requiredPaseo,
  };
}
