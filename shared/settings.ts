import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** 内置快捷预设：每行「标题::提示词」。 */
export const sidekickSettings = defineSettings({
  id: "bytheway-settings",
  scope: "host",
  version: 2,
  schema: z.object({
    // 新线程默认
    defaultMode: z.enum(["ask", "work"]).default("ask"),
    defaultModel: z.string().default("follow"),

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
    maxConcurrentAsk: z.number().int().min(1).max(8).default(3),
    maxConcurrentWork: z.number().int().min(1).max(8).default(2),
    maxConcurrentTotal: z.number().int().min(1).max(16).default(8),
    experimentalCancel: z.boolean().default(true),
  }),
  migrate: (values, fromVersion) => {
    if (fromVersion < 2 && values && typeof values === "object") {
      const v = values as { permissionPolicy?: string };
      if (v.permissionPolicy === "ask") return { ...v, permissionPolicy: "follow" };
    }
    return values;
  },
});

export type SidekickSettings = z.infer<typeof sidekickSettings.schema>;
