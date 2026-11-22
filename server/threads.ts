import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { randomUUID } from "node:crypto";
import { PROMPT_MARKERS } from "../shared/prompt-markers";
import type { TextAttachment, ThreadRuntimeStatus } from "../shared/contracts";
import {
  attachmentFallbackText,
  splitUserAttachments,
  type UserAttachment,
} from "../shared/attachments";
import type { SidekickSettings } from "../shared/settings";
import type { ThreadMode, ThreadRecord } from "../shared/types";
import type { EffectiveAgentConfig } from "../shared/model-configs";
import { resolveSendBehavior, type AppliedBehavior } from "../shared/send-behavior";
import { inheritedThinkingOptionId, resolveRequestedThinkingOptionId } from "../shared/thinking";
import {
  agentFeatureValues,
  defaultProviderModeId,
  inheritedProviderModeId,
  sameFeatureValues,
  threadModeForProviderMode,
} from "../shared/controls";
import {
  buildIncrementText,
  buildSnapshotText,
  buildSystemPrompt,
  detectToolsAvailable,
  fetchTranscriptTail,
  PASSIVE_SNAPSHOT_BUDGET,
  PASSIVE_SNAPSHOT_MESSAGES,
} from "./context";
import * as registry from "./registry";
import {
  removeThreadUploads,
  saveMessageAttachments,
  sweepStaleUploads,
  type UploadedFileAttachment,
} from "./uploads";

export type PaseoApi = PluginHandlerContext["paseo"];
type AgentHandle = ReturnType<PaseoApi["agents"]["ref"]>;
type AgentSnapshot = NonNullable<Awaited<ReturnType<AgentHandle["refresh"]>>>["agent"];
type WorkspaceHandle = ReturnType<PaseoApi["workspaces"]["ref"]>;
type CreateOptions = Parameters<WorkspaceHandle["agents"]["create"]>[0];
type Attachment = NonNullable<CreateOptions["attachments"]>[number];
type OutgoingTextAttachment = { type: "text"; mimeType: "text/plain"; title: string; text: string };
type OutgoingAttachment = OutgoingTextAttachment | UploadedFileAttachment;
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const TITLE_MAX = 60;
const META_THREAD_ID = "bytheway.threadId";
const META_MAIN_AGENT_ID = "bytheway.mainAgentId";
const META_TITLE = "bytheway.title";
const META_PINNED = "bytheway.pinned";
const META_SYNC_CURSOR = "bytheway.syncCursor";
const META_UPDATED_AT = "bytheway.updatedAt";

function threadMetadata(record: ThreadRecord): Record<string, JsonValue> {
  return {
    [META_THREAD_ID]: record.id,
    [META_MAIN_AGENT_ID]: record.mainAgentId,
    [META_TITLE]: record.title,
    [META_PINNED]: record.pinned,
    [META_SYNC_CURSOR]: record.syncCursor as JsonValue,
    [META_UPDATED_AT]: record.updatedAt,
  };
}

function metadataString(agent: AgentSnapshot | null | undefined, key: string): string | null {
  const value = agent?.metadata?.[key];
  return typeof value === "string" ? value : null;
}

function metadataBoolean(agent: AgentSnapshot | null | undefined, key: string): boolean | null {
  const value = agent?.metadata?.[key];
  return typeof value === "boolean" ? value : null;
}

function metadataNumber(agent: AgentSnapshot | null | undefined, key: string): number | null {
  const value = agent?.metadata?.[key];
  return typeof value === "number" ? value : null;
}

function metadataCursor(
  agent: AgentSnapshot | null | undefined,
): ThreadRecord["syncCursor"] {
  const value = agent?.metadata?.[META_SYNC_CURSOR];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const unitsSeen = (value as { unitsSeen?: unknown }).unitsSeen;
  const messagesSeen = (value as { messagesSeen?: unknown }).messagesSeen;
  if (typeof unitsSeen !== "number" || typeof messagesSeen !== "number") return null;
  return { unitsSeen, messagesSeen };
}

function mergeThreadMetadata(thread: ThreadRecord, agent: AgentSnapshot): ThreadRecord {
  const metadataUpdatedAt = metadataNumber(agent, META_UPDATED_AT);
  const metadataIsNewer = metadataUpdatedAt === null || metadataUpdatedAt >= thread.updatedAt;
  const title = metadataIsNewer ? metadataString(agent, META_TITLE) : null;
  const pinned = metadataIsNewer ? metadataBoolean(agent, META_PINNED) : null;
  const mainAgentId = metadataString(agent, META_MAIN_AGENT_ID);
  const syncCursor = metadataIsNewer
    ? metadataCursor(agent) ?? thread.syncCursor
    : thread.syncCursor;
  const next: ThreadRecord = {
    ...thread,
    title: title ?? thread.title,
    pinned: pinned ?? thread.pinned,
    mainAgentId: mainAgentId ?? thread.mainAgentId,
    syncCursor,
  };
  const changed =
    next.title !== thread.title ||
    next.pinned !== thread.pinned ||
    next.mainAgentId !== thread.mainAgentId ||
    next.syncCursor !== thread.syncCursor;
  return changed ? next : thread;
}

async function writeThreadMetadata(paseo: PaseoApi, thread: ThreadRecord): Promise<void> {
  try {
    await paseo.agents.ref(thread.agentId).setMetadata(threadMetadata(thread));
  } catch {
    // metadata 是恢复用冗余；写失败不影响主流程
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncateOneLine(text: string, max = TITLE_MAX): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
}

function textAttachment(title: string, text: string): OutgoingTextAttachment {
  return { type: "text", mimeType: "text/plain", title, text };
}

/** 解析 "provider/model"（provider 恒为第一段，兼容模型 id 含 "/"）。 */
function splitModel(value: string): { provider: string | null; model: string } {
  const slash = value.indexOf("/");
  return slash > 0 ? { provider: value.slice(0, slash), model: value.slice(slash + 1) } : { provider: null, model: value };
}

function effectiveConfigFromThread(thread: ThreadRecord): EffectiveAgentConfig {
  return {
    provider: thread.provider,
    model: thread.model,
    modeId: thread.modeId,
    thinkingOptionId: thread.thinkingOptionId,
    featureValues: thread.featureValues,
  };
}

async function promptModeForProviderMode(
  paseo: PaseoApi,
  provider: string,
  modeId: string | null,
): Promise<ThreadMode | "provider"> {
  if (!modeId) return "provider";
  const result = await paseo.providers.listModes(provider).catch(() => null);
  const mode = result?.modes?.find((entry) => entry.id === modeId);
  return mode ? threadModeForProviderMode(mode) : "provider";
}

interface ContextModeInfo {
  toolsAvailable: boolean;
  passive: boolean;
}

async function resolveContextMode(paseo: PaseoApi, settings: SidekickSettings): Promise<ContextModeInfo> {
  const toolsAvailable = await detectToolsAvailable(paseo);
  const passive = !toolsAvailable && settings.contextFallback === "auto";
  return { toolsAvailable, passive };
}

/* ------------------------------------------------------------------ */
/* 并发门控                                                              */
/* ------------------------------------------------------------------ */

async function assertConcurrency(paseo: PaseoApi, settings: SidekickSettings): Promise<void> {
  let entries: Array<{ agent: { status: string; labels?: Record<string, string> } }> = [];
  try {
    const listing = await paseo.agents.list({
      filter: { labels: { sidekick: "1" }, statuses: ["running"], includeArchived: false },
    });
    entries = listing.entries as typeof entries;
  } catch {
    return; // 列表失败不阻塞发送
  }
  if (entries.length >= settings.maxConcurrentTotal) {
    throw new Error(`侧聊总并发已达上限（${settings.maxConcurrentTotal}），请等待现有侧聊完成`);
  }
}

/* ------------------------------------------------------------------ */
/* 核心操作                                                              */
/* ------------------------------------------------------------------ */

export interface AskInput {
  mainAgentId: string;
  question: string;
  attachments?: UserAttachment[];
  mode: ThreadMode;
  target: { kind: "continue"; threadId?: string } | { kind: "new" };
  model?: string;
  modeId?: string | null;
  thinkingOptionId?: string | null;
  featureValues?: Record<string, unknown>;
  continuationOf?: string;
  clientRequestId?: string;
}

export interface AskResult {
  threadId: string;
  agentId: string;
  created: boolean;
  /** 实际生效的发送方式：send=普通发送，interrupt=打断了运行中的回答。 */
  behavior: AppliedBehavior;
  /** 实际使用的模型控制项；仅由 RPC 层决定是否写入模型配置记忆。 */
  effectiveConfig: EffectiveAgentConfig;
}

export async function askThread(paseo: PaseoApi, settings: SidekickSettings, input: AskInput): Promise<AskResult> {
  await registry.ensureLoaded();

  if (input.clientRequestId) {
    const knownId = registry.lookupRequestId(input.clientRequestId);
    const known = knownId ? registry.getThread(knownId) : undefined;
    if (known) {
      return {
        threadId: known.id,
        agentId: known.agentId,
        created: false,
        behavior: "send",
        effectiveConfig: effectiveConfigFromThread(known),
      };
    }
  }

  const mainRef = await paseo.agents.ref(input.mainAgentId).refresh();
  if (!mainRef) throw new Error("主会话不存在或已不可用");
  const main = mainRef.agent;
  if (!main.workspaceId) throw new Error("主会话没有所属 workspace，无法创建旁路会话");

  // 解析 provider / model（支持 "provider/model" 覆盖）
  let provider = main.provider;
  let model = main.model ?? "";
  const requested = input.model?.trim();
  const configured = settings.defaultModel.trim();
  const source = requested || (configured && configured !== "follow" ? configured : "");
  if (source) {
    const slash = source.indexOf("/");
    if (slash > 0) {
      provider = source.slice(0, slash);
      model = source.slice(slash + 1);
    } else {
      model = source;
    }
  }

  const contextMode = await resolveContextMode(paseo, settings);

  // 默认跟随主会话：同 provider/model 时继承思考档；换模型时使用目标模型默认档。
  const inheritedThinking = inheritedThinkingOptionId(provider, model, main);
  const selectedThinkingOptionId = resolveRequestedThinkingOptionId(
    input.thinkingOptionId,
    inheritedThinking,
  );
  const inheritedFeatureValues = provider === main.provider ? agentFeatureValues(main) : {};
  const selectedFeatureValues =
    input.featureValues !== undefined ? input.featureValues : inheritedFeatureValues;
  // 默认 follow 主会话：同 provider/model 时连 mode 一起继承；否则使用 provider 默认。
  const requestedModeId =
    input.modeId !== undefined
      ? input.modeId
      : inheritedProviderModeId(provider, model, main);

  if (input.target.kind === "continue") {
    const thread = input.target.threadId
      ? registry.getThread(input.target.threadId)
      : registry.findLastActive(input.mainAgentId);
    if (thread) {
      if (thread.state !== "open") {
        throw new Error("该侧聊已停止：可「重建并继续」，或用 /btw-new 新开线程");
      }
      return continueThread(paseo, settings, thread, input, contextMode);
    }
  }

  await assertConcurrency(paseo, settings);
  const record = await createThread(paseo, settings, {
    mainAgentId: input.mainAgentId,
    workspaceId: main.workspaceId,
    provider,
    model,
    mode: input.mode,
    modeId: requestedModeId,
    thinkingOptionId: selectedThinkingOptionId,
    featureValues: selectedFeatureValues,
    question: input.question,
    attachments: input.attachments,
    contextMode,
    seedFromAgentId: input.continuationOf ?? null,
  });
  if (input.clientRequestId) registry.rememberRequestId(input.clientRequestId, record.id);
  return {
    threadId: record.id,
    agentId: record.agentId,
    created: true,
    behavior: "send",
    effectiveConfig: effectiveConfigFromThread(record),
  };
}

async function continueThread(
  paseo: PaseoApi,
  settings: SidekickSettings,
  thread: ThreadRecord,
  input: AskInput,
  contextMode: ContextModeInfo,
): Promise<AskResult> {
  const handle: AgentHandle = paseo.agents.ref(thread.agentId);
  const snapshot = await handle.refresh();
  const agent = snapshot?.agent;
  if (!agent || agent.archivedAt) {
    registry.upsertThread({
      ...thread,
      state: "stopped",
      stateReason: "会话已归档或不存在",
      updatedAt: Date.now(),
    });
    throw new Error("该侧聊已停止：可「重建并继续」，或用 /btw-new 新开线程");
  }

  const busy = agent.status === "running";
  // 运行中不再报错：直接打断当前回答并发送。
  const behavior = resolveSendBehavior(busy);

  const attachments: OutgoingAttachment[] = [];
  if (contextMode.passive) {
    try {
      const tail = await fetchTranscriptTail(paseo, thread.mainAgentId);
      if (tail.unreliable) {
        attachments.push(
          textAttachment(
            "主会话上下文快照.md",
            buildSnapshotText(tail, {
              messages: PASSIVE_SNAPSHOT_MESSAGES,
              includeDigest: settings.includeActionDigest,
              budget: PASSIVE_SNAPSHOT_BUDGET,
              passive: true,
            }),
          ),
        );
        const nextThread = {
          ...thread,
          syncCursor: { unitsSeen: tail.units.length, messagesSeen: tail.messagesSeen },
        };
        registry.upsertThread(nextThread);
        void writeThreadMetadata(paseo, nextThread);
      } else {
        const increment = buildIncrementText(tail, thread.syncCursor, settings.includeActionDigest);
        if (increment) {
          attachments.push(textAttachment("主会话增量更新.md", increment.text));
          const nextThread = { ...thread, syncCursor: increment.cursor };
          registry.upsertThread(nextThread);
          void writeThreadMetadata(paseo, nextThread);
        }
      }
    } catch (error) {
      console.error("[bytheway] passive sync failed", message(error));
    }
  }

  if (input.model) {
    const desired = splitModel(input.model);
    if (desired.provider && desired.provider !== thread.provider) {
      throw new Error("已有侧聊不能切换 provider：请用 /btw-new 新开线程再选其它 provider");
    }
  }

  const userAttachments = input.attachments ?? [];
  const { images } = splitUserAttachments(userAttachments);
  const messageId = randomUUID();
  if (userAttachments.length > 0) {
    attachments.push(...(await saveMessageAttachments(thread.id, messageId, userAttachments)));
  }
  const question = input.question || attachmentFallbackText(userAttachments);

  const sendOptions = {
    messageId,
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(images.length > 0 ? { images } : {}),
    ...(behavior !== "send" ? { activeTurnBehavior: behavior } : {}),
  };
  await handle.send(question, sendOptions);

  const after = await handle.refresh().catch(() => null);
  const updated = after?.agent ?? agent;
  const nextModel = updated.model ?? thread.model;
  const nextModeId = updated.currentModeId ?? thread.modeId;
  const nextThinkingOptionId = updated.thinkingOptionId ?? null;
  const actualFeatureValues = agentFeatureValues(updated);
  const nextFeatureValues =
    Object.keys(actualFeatureValues).length > 0 ? actualFeatureValues : thread.featureValues;
  const promptMode = await promptModeForProviderMode(paseo, thread.provider, nextModeId);
  const nextThreadMode = promptMode === "provider" ? input.mode : promptMode;

  const nextThread = {
    ...thread,
    mode: nextThreadMode,
    model: nextModel,
    modeId: nextModeId,
    thinkingOptionId: nextThinkingOptionId,
    featureValues: nextFeatureValues,
    updatedAt: Date.now(),
  };
  registry.upsertThread(nextThread);
  void writeThreadMetadata(paseo, nextThread);
  console.log(
    `[bytheway] thread ${thread.id} ${nextThreadMode !== thread.mode ? `mode switched to ${nextThreadMode}` : "continued"} (${behavior})`,
  );
  return {
    threadId: thread.id,
    agentId: thread.agentId,
    created: false,
    behavior,
    effectiveConfig: {
      provider: thread.provider,
      model: nextModel,
      modeId: nextModeId,
      thinkingOptionId: nextThinkingOptionId,
      featureValues: nextFeatureValues,
    },
  };
}

interface CreateThreadInput {
  mainAgentId: string;
  workspaceId: string;
  provider: string;
  model: string;
  mode: ThreadMode;
  modeId: string | null;
  thinkingOptionId: string | null;
  /** 从主会话继承的 provider features（如 opencode auto_accept）。 */
  featureValues: Record<string, unknown>;
  question: string;
  attachments?: UserAttachment[];
  contextMode: ContextModeInfo;
  seedFromAgentId: string | null;
}

async function createThread(
  paseo: PaseoApi,
  settings: SidekickSettings,
  input: CreateThreadInput,
): Promise<ThreadRecord> {
  const threadId = registry.newThreadId();
  const promptMode = await promptModeForProviderMode(paseo, input.provider, input.modeId);
  const effectiveThreadMode = promptMode === "provider" ? input.mode : promptMode;
  const systemPrompt = buildSystemPrompt({
    mainAgentId: input.mainAgentId,
    mode: promptMode,
    toolsAvailable: input.contextMode.toolsAvailable,
    passive: input.contextMode.passive,
  });

  const attachments: OutgoingAttachment[] = [];
  let syncCursor: ThreadRecord["syncCursor"] = null;
  try {
    if (input.contextMode.passive) {
      const tail = await fetchTranscriptTail(paseo, input.mainAgentId);
      attachments.push(
        textAttachment(
          "主会话上下文快照.md",
          buildSnapshotText(tail, {
            messages: PASSIVE_SNAPSHOT_MESSAGES,
            includeDigest: settings.includeActionDigest,
            budget: PASSIVE_SNAPSHOT_BUDGET,
            passive: true,
          }),
        ),
      );
      syncCursor = { unitsSeen: tail.units.length, messagesSeen: tail.messagesSeen };
    } else if (settings.snapshotDepth > 0) {
      const tail = await fetchTranscriptTail(paseo, input.mainAgentId);
      attachments.push(
        textAttachment(
          "主会话上下文快照.md",
          buildSnapshotText(tail, {
            messages: settings.snapshotDepth,
            includeDigest: settings.includeActionDigest,
          }),
        ),
      );
    }
  } catch (error) {
    console.error("[bytheway] snapshot build failed", message(error));
  }

  const userAttachments = input.attachments ?? [];
  const { images } = splitUserAttachments(userAttachments);
  const messageId = randomUUID();
  if (userAttachments.length > 0) {
    attachments.push(...(await saveMessageAttachments(threadId, messageId, userAttachments)));
  }
  const question = input.question || attachmentFallbackText(userAttachments);

  // 接续线程（换模型/模式后新开）：让新线程先读取旧线程的上下文
  let prompt = question;
  if (input.seedFromAgentId) {
    if (input.contextMode.toolsAvailable) {
      prompt = `${PROMPT_MARKERS.continuationPrefix}（用户更换了模型或模式）。请先调用 MCP 工具 get_agent_activity 读取 agent ${input.seedFromAgentId} 的最近活动，了解先前对话的结论与语气，${PROMPT_MARKERS.continuationQuestion}\n\n${question}`;
    } else {
      try {
        const tail = await fetchTranscriptTail(paseo, input.seedFromAgentId, 80);
        attachments.push(
          textAttachment(
            "接续速记.md",
            `${PROMPT_MARKERS.previousThreadSummary}（接续用）：\n\n${buildSnapshotText(tail, {
              messages: 10,
              includeDigest: settings.includeActionDigest,
              budget: PASSIVE_SNAPSHOT_BUDGET,
              passive: true,
            })}`,
          ),
        );
      } catch (error) {
        console.error("[bytheway] continuation digest failed", message(error));
      }
    }
  }

  const now = Date.now();
  const title = `[侧聊] ${truncateOneLine(question)}`;
  const handle = await paseo.workspaces.ref(input.workspaceId).agents.create({
    config: {
      provider: input.model ? `${input.provider}/${input.model}` : input.provider,
      ...(input.modeId ? { modeId: input.modeId } : {}),
      ...(input.thinkingOptionId ? { thinkingOptionId: input.thinkingOptionId } : {}),
      ...(Object.keys(input.featureValues).length > 0 ? { options: input.featureValues } : {}),
      systemPrompt,
    },
    title,
    prompt,
    clientMessageId: messageId,
    ...(images.length > 0 ? { images } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    labels: { sidekick: "1", "sidekick.thread": threadId, "sidekick.main": input.mainAgentId },
    metadata: {
      [META_THREAD_ID]: threadId,
      [META_MAIN_AGENT_ID]: input.mainAgentId,
      [META_TITLE]: title,
      [META_PINNED]: false,
      [META_SYNC_CURSOR]: syncCursor as JsonValue,
      [META_UPDATED_AT]: now,
    },
    ...(settings.attachToMain ? { parent: input.mainAgentId } : {}),
  });

  const createdSnapshot = await paseo.agents.ref(handle.id).refresh().catch(() => null);
  const actualModeId = createdSnapshot?.agent.currentModeId ?? input.modeId;
  const actualFeatures = createdSnapshot
    ? agentFeatureValues(createdSnapshot.agent)
    : {};
  const recordFeatureValues =
    Object.keys(actualFeatures).length > 0 ? actualFeatures : input.featureValues;
  const record: ThreadRecord = {
    id: threadId,
    mainAgentId: input.mainAgentId,
    workspaceId: input.workspaceId,
    agentId: handle.id,
    title,
    mode: effectiveThreadMode,
    provider: input.provider,
    model: input.model,
    modeId: actualModeId,
    thinkingOptionId: input.thinkingOptionId,
    featureValues: recordFeatureValues,
    state: "open",
    stateReason: null,
    pinned: false,
    createdAt: now,
    updatedAt: now,
    syncCursor,
  };
  registry.upsertThread(record);
  console.log(`[bytheway] thread ${threadId} created (agent ${handle.id}, mode=${input.mode})`);
  maybeGenerateTitle(paseo, settings, record);
  return record;
}

/**
 * 异步为线程生成简短标题：创建隐藏的临时 agent，用线程同款 provider/model 生成；
 * 仅在用户未手动改名（标题仍是最初的截断提问）时覆盖。
 */
function maybeGenerateTitle(paseo: PaseoApi, settings: SidekickSettings, record: ThreadRecord): void {
  if (!settings.aiTitles) return;
  const threadId = record.id;
  const baseTitle = record.title;
  const question = baseTitle.replace(/^\[侧聊(·Build)?\]\s*/, "");

  // 标题生成模型：follow = 线程同款；或 "provider/model"
  const requestedTitleModel = settings.titleModel.trim();
  let titleProvider = record.provider;
  let titleModel = record.model;
  if (requestedTitleModel && requestedTitleModel !== "follow") {
    const slash = requestedTitleModel.indexOf("/");
    if (slash > 0) {
      titleProvider = requestedTitleModel.slice(0, slash);
      titleModel = requestedTitleModel.slice(slash + 1);
    } else {
      titleModel = requestedTitleModel;
    }
  }

  void (async () => {
    try {
      const helper = await paseo.workspaces.ref(record.workspaceId).agents.create({
        config: { provider: titleModel ? `${titleProvider}/${titleModel}` : titleProvider },
        title: "[侧聊·命名]",
        labels: { sidekick: "helper" },
        background: true,
      });
      try {
        const result = await helper.run(
          `为下面这条侧聊问题生成一个简短标题（4~10 个汉字或等长短语，不要标点、不要引号，只输出标题本身）：\n\n${question}`,
          { timeoutMs: 60_000 },
        );
        const raw = (result.lastMessage ?? "").split("\n")[0]?.trim() ?? "";
        const title = raw.replace(/^[“”"'「」【\s]+|[“”"'「」【\s]+$/g, "").slice(0, 30);
        const current = registry.getThread(threadId);
        if (title && current && current.title === baseTitle) {
          const nextThread = { ...current, title };
          registry.upsertThread(nextThread);
          void writeThreadMetadata(paseo, nextThread);
          console.log(`[bytheway] thread ${threadId} title generated (${title.length} chars)`);
        }
      } finally {
        void helper.archive().catch(() => {});
      }
    } catch (error) {
      console.error("[bytheway] title generation failed", message(error));
    }
  })();
}

/* ------------------------------------------------------------------ */
/* 其它操作                                                              */
/* ------------------------------------------------------------------ */

export async function archiveThread(paseo: PaseoApi, threadId: string): Promise<void> {
  await registry.ensureLoaded();
  const thread = registry.getThread(threadId);
  if (!thread) throw new Error("线程不存在");
  try {
    await paseo.agents.ref(thread.agentId).archive();
  } catch (error) {
    console.error("[bytheway] archive agent failed", message(error));
  }
  registry.upsertThread({ ...thread, state: "stopped", stateReason: "已停止", updatedAt: Date.now() });
}

export async function removeThread(paseo: PaseoApi, threadId: string): Promise<void> {
  await registry.ensureLoaded();
  const thread = registry.getThread(threadId);
  if (!thread) return;
  try {
    await paseo.agents.ref(thread.agentId).archive();
  } catch {
    // best effort
  }
  try {
    await paseo.agents.ref(thread.agentId).setMetadata({
      [META_THREAD_ID]: null,
      [META_MAIN_AGENT_ID]: null,
      [META_TITLE]: null,
      [META_PINNED]: null,
      [META_SYNC_CURSOR]: null,
      [META_UPDATED_AT]: null,
    });
  } catch {
    // best effort
  }
  registry.removeThread(threadId);
  await removeThreadUploads(threadId).catch(() => {});
}

export async function renameThread(paseo: PaseoApi, threadId: string, title: string): Promise<void> {
  await registry.ensureLoaded();
  const thread = registry.getThread(threadId);
  if (!thread) throw new Error("线程不存在");
  const nextThread = { ...thread, title: truncateOneLine(title, 120), updatedAt: Date.now() };
  registry.upsertThread(nextThread);
  await writeThreadMetadata(paseo, nextThread);
}

export async function pinThread(paseo: PaseoApi, threadId: string, pinned: boolean): Promise<void> {
  await registry.ensureLoaded();
  const thread = registry.getThread(threadId);
  if (!thread) throw new Error("线程不存在");
  const nextThread = { ...thread, pinned, updatedAt: Date.now() };
  registry.upsertThread(nextThread);
  await writeThreadMetadata(paseo, nextThread);
}

export async function rebuildThread(
  paseo: PaseoApi,
  settings: SidekickSettings,
  threadId: string,
  question?: string,
  modelOverride?: string,
  thinkingOverride?: string | null,
  modeOverride?: string | null,
  featureValuesOverride?: Record<string, unknown>,
  userAttachments?: UserAttachment[],
): Promise<{ threadId: string; agentId: string; effectiveConfig: EffectiveAgentConfig }> {
  await registry.ensureLoaded();
  const thread = registry.getThread(threadId);
  if (!thread) throw new Error("线程不存在");

  const contextMode = await resolveContextMode(paseo, settings);
  let provider = thread.provider;
  let model = thread.model;
  if (modelOverride) {
    const slash = modelOverride.indexOf("/");
    if (slash > 0) {
      provider = modelOverride.slice(0, slash);
      model = modelOverride.slice(slash + 1);
    } else {
      model = modelOverride;
    }
  }

  // 跟随主会话：线程没记录思考档或换过模型时，从主会话重新继承；features 按 provider 继承
  const mainRef = await paseo.agents.ref(thread.mainAgentId).refresh().catch(() => null);
  const main = mainRef?.agent ?? null;
  const fallbackThinkingOptionId =
    provider === thread.provider && model === thread.model
      ? thread.thinkingOptionId
      : main
        ? inheritedThinkingOptionId(provider, model, main)
        : null;
  const nextThinkingOptionId = resolveRequestedThinkingOptionId(
    thinkingOverride,
    fallbackThinkingOptionId,
  );
  const inheritedFeatureValues = main && provider === main.provider ? agentFeatureValues(main) : {};
  const fallbackFeatureValues =
    provider === thread.provider && model === thread.model
      ? thread.featureValues
      : inheritedFeatureValues;
  const nextFeatureValues =
    featureValuesOverride !== undefined ? featureValuesOverride : fallbackFeatureValues;
  let nextModeId: string | null;
  if (modeOverride !== undefined) {
    nextModeId = modeOverride;
  } else if (thread.modeId) {
    nextModeId = thread.modeId;
  } else {
    const modes = await paseo.providers.listModes(provider).catch(() => null);
    nextModeId = defaultProviderModeId(modes?.modes ?? []);
  }

  const oldAgentId = thread.agentId;
  const promptMode = await promptModeForProviderMode(paseo, provider, nextModeId);
  const nextThreadMode = promptMode === "provider" ? thread.mode : promptMode;
  const systemPrompt = buildSystemPrompt({
    mainAgentId: thread.mainAgentId,
    mode: promptMode,
    toolsAvailable: contextMode.toolsAvailable,
    passive: contextMode.passive,
  });
  const effectiveQuestion =
    question?.trim() ||
    (userAttachments?.length ? attachmentFallbackText(userAttachments) : "");
  const seed = contextMode.toolsAvailable
    ? `${PROMPT_MARKERS.rebuildPrefix}。请先调用 MCP 工具 get_agent_activity 读取 agent ${oldAgentId} 的最近活动，了解该线程此前的问答与结论，继承其上下文与语气。${PROMPT_MARKERS.rebuildQuestion}\n\n${effectiveQuestion || PROMPT_MARKERS.emptyRebuildSummary}`
    : `${PROMPT_MARKERS.rebuildPrefix}。\n\n${effectiveQuestion || PROMPT_MARKERS.emptyRebuildWait}`;

  const attachments: OutgoingAttachment[] = [];
  if (!contextMode.toolsAvailable) {
    try {
      const tail = await fetchTranscriptTail(paseo, oldAgentId, 80);
      attachments.push(
        textAttachment(
          "旧线程速记.md",
          `${PROMPT_MARKERS.rebuiltThreadSummary}（可能不完整）：\n\n${buildSnapshotText(tail, {
            messages: 12,
            includeDigest: settings.includeActionDigest,
            budget: PASSIVE_SNAPSHOT_BUDGET,
            passive: true,
          })}`,
        ),
      );
    } catch (error) {
      console.error("[bytheway] rebuild digest failed", message(error));
    }
  }

  const { images } = splitUserAttachments(userAttachments ?? []);
  const messageId = randomUUID();
  if ((userAttachments ?? []).length > 0) {
    attachments.push(...(await saveMessageAttachments(thread.id, messageId, userAttachments ?? [])));
  }

  const now = Date.now();
  const handle = await paseo.workspaces.ref(thread.workspaceId).agents.create({
    config: {
      provider: model ? `${provider}/${model}` : provider,
      ...(nextModeId ? { modeId: nextModeId } : {}),
      ...(nextThinkingOptionId ? { thinkingOptionId: nextThinkingOptionId } : {}),
      ...(Object.keys(nextFeatureValues).length > 0 ? { options: nextFeatureValues } : {}),
      systemPrompt,
    },
    title: thread.title,
    prompt: seed,
    clientMessageId: messageId,
    ...(images.length > 0 ? { images } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    labels: { sidekick: "1", "sidekick.thread": thread.id, "sidekick.main": thread.mainAgentId },
    metadata: {
      [META_THREAD_ID]: thread.id,
      [META_MAIN_AGENT_ID]: thread.mainAgentId,
      [META_TITLE]: thread.title,
      [META_PINNED]: thread.pinned,
      [META_SYNC_CURSOR]: null,
      [META_UPDATED_AT]: now,
    },
    ...(settings.attachToMain ? { parent: thread.mainAgentId } : {}),
  });

  const createdSnapshot = await paseo.agents.ref(handle.id).refresh().catch(() => null);
  const actualModeId = createdSnapshot?.agent.currentModeId ?? nextModeId;
  const actualFeatures = createdSnapshot
    ? agentFeatureValues(createdSnapshot.agent)
    : {};
  const record: ThreadRecord = {
    ...thread,
    agentId: handle.id,
    mode: nextThreadMode,
    provider,
    model,
    modeId: actualModeId,
    thinkingOptionId: nextThinkingOptionId,
    featureValues: Object.keys(actualFeatures).length > 0 ? actualFeatures : nextFeatureValues,
    state: "open",
    stateReason: null,
    updatedAt: now,
    syncCursor: null,
  };
  registry.upsertThread(record);
  console.log(`[bytheway] thread ${thread.id} rebuilt (agent ${handle.id})`);
  return {
    threadId: thread.id,
    agentId: handle.id,
    effectiveConfig: effectiveConfigFromThread(record),
  };
}

export async function cancelThread(
  paseo: PaseoApi,
  threadId: string,
): Promise<{ requested: boolean; note: string }> {
  await registry.ensureLoaded();
  const thread = registry.getThread(threadId);
  if (!thread) throw new Error("线程不存在");
  const snapshot = await paseo.agents.ref(thread.agentId).refresh();
  if (!snapshot || snapshot.agent.status !== "running") {
    return { requested: false, note: "侧聊当前不在运行中" };
  }
  try {
    const helper = await paseo.workspaces.ref(thread.workspaceId).agents.create({
      config: { provider: thread.model ? `${thread.provider}/${thread.model}` : thread.provider },
      title: "[侧聊·取消辅助]",
      prompt: `请调用 MCP 工具 cancel_agent，参数 agentId=${thread.agentId}，中止该 agent 的当前运行。成功后回复 done；如果工具不可用请回复 tool-unavailable。`,
      labels: { sidekick: "helper" },
      background: true,
    });
    // 辅助 agent 用完即弃（90 秒后归档，尽力而为）
    const helperId = helper.id;
    setTimeout(() => {
      void paseo.agents.ref(helperId).archive().catch(() => {});
    }, 90_000);
  } catch (error) {
    return { requested: false, note: `辅助取消发起失败：${message(error)}` };
  }
  return { requested: true, note: "已发起取消请求（实验性）；5 秒未生效请在标签页中停止" };
}

export async function sendToMain(
  paseo: PaseoApi,
  threadId: string,
  text: string,
  behavior: "auto" | "steer" | "send",
): Promise<{ behavior: "steer" | "send" }> {
  await registry.ensureLoaded();
  const thread = registry.getThread(threadId);
  if (!thread) throw new Error("线程不存在");
  const snapshot = await paseo.agents.ref(thread.mainAgentId).refresh();
  const running = snapshot?.agent.status === "running";
  const useSteer = behavior === "steer" || (behavior === "auto" && running);
  await paseo.agents.ref(thread.mainAgentId).send(text, useSteer ? { activeTurnBehavior: "steer" } : undefined);
  return { behavior: useSteer ? "steer" : "send" };
}

export interface PreviewResult {
  contextMode: "linked" | "passive";
  toolsAvailable: boolean;
  systemPrompt: string;
  messageText: string;
  attachments: TextAttachment[];
}

export async function previewContext(
  paseo: PaseoApi,
  settings: SidekickSettings,
  input: { mainAgentId: string; mode: ThreadMode; question: string },
): Promise<PreviewResult> {
  const contextMode = await resolveContextMode(paseo, settings);
  const systemPrompt = buildSystemPrompt({
    mainAgentId: input.mainAgentId,
    mode: input.mode,
    toolsAvailable: contextMode.toolsAvailable,
    passive: contextMode.passive,
  });
  const attachments: TextAttachment[] = [];
  try {
    if (contextMode.passive) {
      const tail = await fetchTranscriptTail(paseo, input.mainAgentId);
      attachments.push(
        textAttachment(
          "主会话上下文快照.md",
          buildSnapshotText(tail, {
            messages: PASSIVE_SNAPSHOT_MESSAGES,
            includeDigest: settings.includeActionDigest,
            budget: PASSIVE_SNAPSHOT_BUDGET,
            passive: true,
          }),
        ),
      );
    } else if (settings.snapshotDepth > 0) {
      const tail = await fetchTranscriptTail(paseo, input.mainAgentId);
      attachments.push(
        textAttachment(
          "主会话上下文快照.md",
          buildSnapshotText(tail, {
            messages: settings.snapshotDepth,
            includeDigest: settings.includeActionDigest,
          }),
        ),
      );
    }
  } catch {
    // 预览失败时仅返回提示词部分
  }
  return {
    contextMode: contextMode.passive ? "passive" : "linked",
    toolsAvailable: contextMode.toolsAvailable,
    systemPrompt,
    messageText: input.question,
    attachments,
  };
}

/** 清扫：有 sidekick 标签但注册表无记录的孤儿 agent（非 running）。 */
export async function reapOrphans(paseo: PaseoApi): Promise<void> {
  try {
    await registry.ensureLoaded();
    await recoverThreadsFromAgents(paseo);
    const known = registry.knownThreadIds();
    const listing = await paseo.agents.list({
      filter: { labels: { sidekick: "1" }, includeArchived: false },
    });
    for (const entry of listing.entries) {
      const threadId = entry.agent.labels?.["sidekick.thread"];
      if (threadId && known.has(threadId)) continue;
      if (entry.agent.status === "running") continue;
      try {
        await paseo.agents.ref(entry.agent.id).archive();
        console.log(`[bytheway] reaped orphan agent ${entry.agent.id}`);
      } catch {
        // best effort
      }
    }

    // 遗留的辅助 agent（取消辅助 / 命名辅助）：非运行中且超过 10 分钟未更新则回收
    const helpers = await paseo.agents.list({
      filter: { labels: { sidekick: "helper" }, includeArchived: false },
      includeBackground: true,
    });
    const cutoff = Date.now() - 10 * 60_000;
    for (const entry of helpers.entries) {
      if (entry.agent.status === "running") continue;
      const updatedAt = Date.parse(String((entry.agent as { updatedAt?: string }).updatedAt ?? ""));
      if (Number.isFinite(updatedAt) && updatedAt < cutoff) {
        try {
          await paseo.agents.ref(entry.agent.id).archive();
          console.log(`[bytheway] reaped stale helper agent ${entry.agent.id}`);
        } catch {
          // best effort
        }
      }
    }

    await sweepStaleUploads();
  } catch (error) {
    console.error("[bytheway] reaper failed", message(error));
  }
}

/** 从带 sidekick 标签和 metadata 的 agent 恢复丢失的线程注册表记录。 */
export async function recoverThreadsFromAgents(paseo: PaseoApi): Promise<void> {
  try {
    await registry.ensureLoaded();
    const listing = await paseo.agents.list({
      filter: { labels: { sidekick: "1" }, includeArchived: true },
      includeBackground: true,
    });
    const known = registry.knownThreadIds();
    for (const entry of listing.entries) {
      const agent = entry.agent;
      if (agent.archivedAt) continue;
      const metaThreadId = metadataString(agent, META_THREAD_ID);
      if (!metaThreadId) continue;
      const threadId = agent.labels?.["sidekick.thread"] ?? metaThreadId;
      if (known.has(threadId)) continue;
      const mainAgentId = metadataString(agent, META_MAIN_AGENT_ID);
      if (!mainAgentId || !agent.workspaceId) continue;
      const title =
        metadataString(agent, META_TITLE) ?? agent.title ?? `[侧聊] ${agent.id}`;
      const state = agent.archivedAt ? "stopped" : "open";
      const record: ThreadRecord = {
        id: threadId,
        mainAgentId,
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        title,
        mode: /plan|read.?only/i.test(`${agent.currentModeId ?? ""} ${title}`)
          ? "ask"
          : "work",
        provider: agent.provider,
        model: agent.model ?? "",
        modeId: agent.currentModeId ?? null,
        thinkingOptionId: agent.thinkingOptionId ?? null,
        featureValues: agentFeatureValues(agent),
        state,
        stateReason: state === "stopped" ? "已归档" : null,
        pinned: metadataBoolean(agent, META_PINNED) ?? false,
        createdAt: Date.parse(String(agent.createdAt ?? "")) || Date.now(),
        updatedAt: Date.parse(String(agent.updatedAt ?? "")) || Date.now(),
        syncCursor: metadataCursor(agent),
      };
      registry.upsertThread(record);
      console.log(`[bytheway] recovered thread ${threadId} from agent ${agent.id}`);
    }
  } catch (error) {
    console.error("[bytheway] thread recovery failed", message(error));
  }
}

/** 列表前批量刷状态：一次 agents.list 映射所有线程，避免 N+1 refresh。 */
export async function refreshThreadStates(
  paseo: PaseoApi,
  mainAgentId: string,
): Promise<Record<string, ThreadRuntimeStatus>> {
  const statuses: Record<string, ThreadRuntimeStatus> = {};
  const threads = registry.listThreads(mainAgentId).slice(0, 12);
  if (threads.length === 0) return statuses;

  let agentsById = new Map<string, AgentSnapshot>();
  try {
    const listing = await paseo.agents.list({
      filter: { labels: { sidekick: "1" }, includeArchived: true },
      includeBackground: true,
    });
    agentsById = new Map(listing.entries.map((entry) => [entry.agent.id, entry.agent]));
  } catch {
    for (const thread of threads) {
      statuses[thread.id] = thread.state === "open" ? "idle" : "closed";
    }
    return statuses;
  }

  for (const thread of threads) {
    if (thread.state !== "open") {
      statuses[thread.id] = "closed";
      continue;
    }
    const agent = agentsById.get(thread.agentId);
    if (!agent) {
      registry.upsertThread({ ...thread, state: "stopped", stateReason: "会话不存在" });
      statuses[thread.id] = "closed";
      continue;
    }
    if (agent.archivedAt) {
      registry.upsertThread({ ...thread, state: "stopped", stateReason: "已归档" });
      statuses[thread.id] = "closed";
      continue;
    }

    const merged = mergeThreadMetadata(thread, agent);
    const actualModeId = agent.currentModeId ?? merged.modeId;
    const actualThinkingOptionId = agent.thinkingOptionId ?? null;
    const actualFeatures = agentFeatureValues(agent);
    const modeDrifted = actualModeId !== merged.modeId;
    const thinkingDrifted = actualThinkingOptionId !== merged.thinkingOptionId;
    const featuresDrifted =
      Object.keys(actualFeatures).length > 0 &&
      !sameFeatureValues(actualFeatures, merged.featureValues);
    if (merged !== thread || modeDrifted || thinkingDrifted || featuresDrifted) {
      registry.upsertThread({
        ...merged,
        modeId: actualModeId,
        thinkingOptionId: actualThinkingOptionId,
        featureValues: featuresDrifted ? actualFeatures : merged.featureValues,
        updatedAt: Date.now(),
      });
    }
    statuses[thread.id] = agent.status;
  }
  return statuses;
}
