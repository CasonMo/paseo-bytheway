/** 与 package.json / paseo-plugin.json 保持一致的插件版本号。 */
export const PLUGIN_ID = "paseo-bytheway";
export const PLUGIN_VERSION = "0.4.1";

/** 简单 semver 比较：a 是否比 b 新（忽略 prerelease）。 */
export function isNewer(a: string, b: string): boolean {
  const parse = (v: string): number[] =>
    v
      .replace(/^v/, "")
      .split(/[-+]/, 1)[0]!
      .split(".")
      .map((n) => Number.parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}
