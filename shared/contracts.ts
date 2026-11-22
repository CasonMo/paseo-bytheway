import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import {
  MAX_ATTACHMENT_BASE64_CHARS,
  MAX_ATTACHMENT_COUNT,
  MAX_TOTAL_BASE64_CHARS,
} from "./attachments";

/* ------------------------------------------------------------------ */
/* 公共 schema                                                          */
/* ------------------------------------------------------------------ */

export const threadModeSchema = z.enum(["ask", "work"]);
export type ThreadMode = z.infer<typeof threadModeSchema>;

export const featureValuesSchema = z.record(z.string(), z.unknown());
export type FeatureValues = z.infer<typeof featureValuesSchema>;

export const threadStateSchema = z.enum(["open", "stopped", "dead"]);
export type ThreadState = z.infer<typeof threadStateSchema>;

/** 线程背后 agent 的运行时状态（用于状态圆点）。 */
export const threadRuntimeStatusSchema = z.enum([
  "initializing",
  "idle",
  "running",
  "error",
  "closed",
]);
export type ThreadRuntimeStatus = z.infer<typeof threadRuntimeStatusSchema>;

export const threadViewSchema = z.object({
  id: z.string(),
  mainAgentId: z.string(),
  workspaceId: z.string(),
  agentId: z.string(),
  title: z.string(),
  mode: threadModeSchema,
  provider: z.string(),
  model: z.string(),
  modeId: z.string().nullable(),
  thinkingOptionId: z.string().nullable(),
  featureValues: featureValuesSchema,
  state: threadStateSchema,
  stateReason: z.string().nullable(),
  pinned: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type ThreadView = z.infer<typeof threadViewSchema>;

export const rememberedModelConfigSchema = z.object({
  modeId: z.string().nullable(),
  thinkingOptionId: z.string().nullable(),
  featureValues: z.record(z.string(), z.union([z.boolean(), z.string()])),
  updatedAt: z.number().int().nonnegative(),
});
export type RememberedModelConfigView = z.infer<typeof rememberedModelConfigSchema>;

export const textAttachmentSchema = z.object({
  type: z.literal("text"),
  mimeType: z.string(),
  title: z.string(),
  text: z.string(),
});
export type TextAttachment = z.infer<typeof textAttachmentSchema>;

/** 用户随提问上传的图片/文件（base64 传输；图片走 images 通道，文件落盘后路径引用）。 */
export const userAttachmentSchema = z
  .object({
    kind: z.enum(["image", "file"]),
    fileName: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(200),
    data: z.string().min(1).max(MAX_ATTACHMENT_BASE64_CHARS),
  })
  .refine((item) => item.kind !== "image" || item.mimeType.startsWith("image/"), {
    message: "image attachment must have an image/* mimeType",
  });
export type UserAttachmentInput = z.infer<typeof userAttachmentSchema>;

export const userAttachmentsSchema = z
  .array(userAttachmentSchema)
  .max(MAX_ATTACHMENT_COUNT)
  .refine(
    (list) => list.reduce((sum, item) => sum + item.data.length, 0) <= MAX_TOTAL_BASE64_CHARS,
    { message: "attachments exceed the total size limit" },
  );

/* ------------------------------------------------------------------ */
/* RPC 目录                                                             */
/* ------------------------------------------------------------------ */

export const threadsList = defineRpc({
  name: "bytheway.threads.list",
  input: z.object({ mainAgentId: z.string().min(1) }),
  output: z.object({
    threads: z.array(threadViewSchema),
    threadStatuses: z.record(z.string(), threadRuntimeStatusSchema),
  }),
});

export const threadsSummary = defineRpc({
  name: "bytheway.threads.summary",
  input: z.object({}),
  output: z.object({
    workspaces: z.record(
      z.string(),
      z.object({
        total: z.number().int().nonnegative(),
        running: z.number().int().nonnegative(),
        attention: z.number().int().nonnegative(),
      }),
    ),
  }),
});

export const modelConfigsList = defineRpc({
  name: "bytheway.model-configs.list",
  input: z.object({}),
  output: z.object({
    configs: z.record(z.string(), rememberedModelConfigSchema),
  }),
});

export const threadsAsk = defineRpc({
  name: "bytheway.threads.ask",
  input: z
    .object({
      mainAgentId: z.string().min(1),
      question: z.string().trim().max(8000),
      attachments: userAttachmentsSchema.optional(),
      mode: threadModeSchema.default("ask"),
      target: z
        .union([
          z.object({ kind: z.literal("continue"), threadId: z.string().min(1).optional() }),
          z.object({ kind: z.literal("new") }),
        ])
        .default({ kind: "continue" }),
      model: z.string().min(1).max(200).optional(),
      modeId: z.string().min(1).max(200).nullable().optional(),
      thinkingOptionId: z.string().min(1).max(200).nullable().optional(),
      featureValues: featureValuesSchema.optional(),
      /** 换模型/模式新开线程时：接续的旧线程 agent id（新线程会读取其上下文）。 */
      continuationOf: z.string().min(1).optional(),
      clientRequestId: z.string().min(1).max(200).optional(),
    })
    .refine((input) => input.question.length > 0 || (input.attachments?.length ?? 0) > 0, {
      message: "question or attachments required",
    }),
  output: z.object({
    threadId: z.string(),
    agentId: z.string(),
    created: z.boolean(),
    /** 实际生效的发送方式：send=普通发送，interrupt=打断了运行中的回答。 */
    behavior: z.enum(["send", "interrupt"]),
  }),
});

/** 消息气泡回显用的已落盘附件（图片带 base64；旧消息无副本时为空）。 */
export const storedAttachmentSchema = z.object({
  kind: z.enum(["image", "file"]),
  fileName: z.string(),
  mimeType: z.string(),
  data: z.string().optional(),
});
export type StoredAttachment = z.infer<typeof storedAttachmentSchema>;

export const uploadsForMessage = defineRpc({
  name: "bytheway.uploads.for-message",
  input: z.object({
    threadId: z.string().min(1).max(200),
    messageId: z.string().min(1).max(200),
  }),
  output: z.object({ attachments: z.array(storedAttachmentSchema) }),
});

export const threadsArchive = defineRpc({
  name: "bytheway.threads.archive",
  input: z.object({ threadId: z.string().min(1) }),
  output: z.object({ ok: z.boolean() }),
});

export const threadsRemove = defineRpc({
  name: "bytheway.threads.remove",
  input: z.object({ threadId: z.string().min(1) }),
  output: z.object({ ok: z.boolean() }),
});

export const threadsRename = defineRpc({
  name: "bytheway.threads.rename",
  input: z.object({ threadId: z.string().min(1), title: z.string().trim().min(1).max(120) }),
  output: z.object({ ok: z.boolean() }),
});

export const threadsPin = defineRpc({
  name: "bytheway.threads.pin",
  input: z.object({ threadId: z.string().min(1), pinned: z.boolean() }),
  output: z.object({ ok: z.boolean() }),
});

export const threadsRebuild = defineRpc({
  name: "bytheway.threads.rebuild",
  input: z.object({
    threadId: z.string().min(1),
    question: z.string().trim().max(8000).optional(),
    attachments: userAttachmentsSchema.optional(),
    model: z.string().min(1).max(200).optional(),
    modeId: z.string().min(1).max(200).nullable().optional(),
    thinkingOptionId: z.string().min(1).max(200).nullable().optional(),
    featureValues: featureValuesSchema.optional(),
  }),
  output: z.object({ threadId: z.string(), agentId: z.string() }),
});

export const threadsCancel = defineRpc({
  name: "bytheway.threads.cancel",
  input: z.object({ threadId: z.string().min(1) }),
  output: z.object({
    requested: z.boolean(),
    note: z.string(),
  }),
});

export const threadsSendToMain = defineRpc({
  name: "bytheway.threads.send-to-main",
  input: z.object({
    threadId: z.string().min(1),
    text: z.string().trim().min(1).max(20000),
    behavior: z.enum(["auto", "steer", "send"]).default("auto"),
  }),
  output: z.object({ behavior: z.enum(["steer", "send"]) }),
});

export const contextPreview = defineRpc({
  name: "bytheway.context.preview",
  input: z.object({
    mainAgentId: z.string().min(1),
    threadId: z.string().min(1).optional(),
    mode: threadModeSchema.default("ask"),
    question: z.string().max(8000).default(""),
  }),
  output: z.object({
    contextMode: z.enum(["linked", "passive"]),
    toolsAvailable: z.boolean(),
    systemPrompt: z.string(),
    messageText: z.string(),
    attachments: z.array(textAttachmentSchema),
  }),
});

/** 检查 GitHub main 上是否比当前安装版本更新（仅展示横幅，不做一键升级）。 */
export const updateCheck = defineRpc({
  name: "bytheway.update.check",
  input: z.object({}),
  output: z.object({
    updateAvailable: z.boolean(),
    current: z.string(),
    latest: z.string().nullable(),
    requiredPaseo: z.string().nullable(),
  }),
});

