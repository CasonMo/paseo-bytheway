import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** 内置快捷预设：每行「标题::提示词」。 */
export const sidekickSettings = defineSettings({
  id: "bytheway-settings",
  scope: "host",
  version: 4,
  schema: z.object({
    // 新线程默认模型；Mode/Thinking/Features 跟随主会话或 provider 默认。
    defaultModel: z.string().default("follow"),
    // 按 provider/model 记住用户实际使用过的 Mode、思考档与 Features。
    rememberModelConfig: z.boolean().default(true),

    // 上下文
    snapshotDepth: z.number().int().min(0).max(50).default(6),
    includeActionDigest: z.boolean().default(true),
    contextFallback: z.enum(["auto", "off"]).default("auto"),

    // 线程行为
    attachToMain: z.boolean().default(true),
    aiTitles: z.boolean().default(true),
    titleModel: z.string().default("follow"),

    // 权限
    permissionPolicy: z.enum(["follow", "ask", "allow-readonly", "deny-all"]).default("follow"),
    permissionTimeoutReadMin: z.number().int().min(0).max(1440).default(15),
    permissionTimeoutWriteMin: z.number().int().min(0).max(1440).default(30),

    // 并发与停止
    maxConcurrentTotal: z.number().int().min(1).max(16).default(8),
    experimentalCancel: z.boolean().default(true),
  }),
  migrate: (values, fromVersion) => {
    if (values && typeof values === "object") {
      let next = values as Record<string, unknown>;
      if (fromVersion < 2 && next.permissionPolicy === "ask") {
        next = { ...next, permissionPolicy: "follow" };
      }
      if (fromVersion < 3) {
        const { defaultMode: _defaultMode, maxConcurrentAsk: _ask, maxConcurrentWork: _work, ...rest } = next;
        next = rest;
      }
      if (fromVersion < 4 && next.rememberModelConfig === undefined) {
        next = { ...next, rememberModelConfig: true };
      }
      return next;
    }
    return values;
  },
});

export type SidekickSettings = z.infer<typeof sidekickSettings.schema>;
