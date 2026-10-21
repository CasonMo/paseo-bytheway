import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { TextAttachment, ThreadRuntimeStatus } from "../shared/contracts";
import type { SidekickSettings } from "../shared/settings";
import type { ThreadMode, ThreadRecord } from "../shared/types";
import {
  buildIncrementText,
  buildSnapshotText,
  buildSystemPrompt,
  detectToolsAvailable,
  fetchTranscriptTail,
  pickReadOnlyMode,
  PASSIVE_SNAPSHOT_BUDGET,
  PASSIVE_SNAPSHOT_MESSAGES,
} from "./context";
import * as registry from "./registry";

export type PaseoApi = PluginHandlerContext["paseo"];
type AgentHandle = ReturnType<PaseoApi["agents"]["ref"]>;
type WorkspaceHandle = ReturnType<PaseoApi["workspaces"]["ref"]>;
type CreateOptions = Parameters<WorkspaceHandle["agents"]["create"]>[0];
type Attachment = NonNullable<CreateOptions["attachments"]>[number];
type OutgoingTextAttachment = { type: "text"; mimeType: "text/plain"; title: string; text: string };

const TITLE_MAX = 60;

/** 就地模式切换时附带的指令（写在消息开头，覆盖创建时的系统提示约束）。 */
const MODE_SWITCH_PROMPTS = {
  zh: {
    toWork:
      '【模式切换 → Build】从现在起你可以执行任务所需的操作（此前“只读建议模式”的约束取消）；保持改动最小。',
    toAsk: "【模式切换 → Chat】以只读建议方式回答：不要修改文件、不要执行有副作用的命令。",
  },
  en: {
    toWork:
      "[Mode switch → Build] You may now perform the actions the task needs; the earlier read-only advice constraint no longer applies. Keep changes minimal.",
    toAsk:
      "[Mode switch → Chat] Answer as read-only advice: do not modify files and do not run commands with side effects.",
  },
} as const;

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

async function assertConcurrency(paseo: PaseoApi, settings: SidekickSettings, mode: ThreadMode): Promise<void> {
  let entries: Array<{ agent: { status: string; labels?: Record<string, string> } }> = [];
  try {
    const listing = await paseo.agents.list({
      filter: { labels: { sidekick: "1" }, statuses: ["running"], includeArchived: false },
    });
    entries = listing.entries as typeof entries;
  } catch {
    return; // 列表失败不阻塞发送
  }
  let total = 0;
  let ask = 0;
  let work = 0;
  for (const entry of entries) {
    total += 1;
    const threadId = entry.agent.labels?.["sidekick.thread"];
    const record = threadId ? registry.getThread(threadId) : undefined;
    if ((record?.mode ?? "ask") === "work") work += 1;
    else ask += 1;
  }
  if (total >= settings.maxConcurrentTotal) {
    throw new Error(`侧聊总并发已达上限（${settings.maxConcurrentTotal}），请等待现有侧聊完成`);
  }
  if (mode === "work" && work >= settings.maxConcurrentWork) {
    throw new Error(`Build 并发已达上限（${settings.maxConcurrentWork}），请稍后再试`);
  }
  if (mode === "ask" && ask >= settings.maxConcurrentAsk) {
    throw new Error(`Chat 并发已达上限（${settings.maxConcurrentAsk}），请稍后再试`);
  }
}

/* ------------------------------------------------------------------ */
/* 核心操作                                                              */
/* ------------------------------------------------------------------ */

export interface AskInput {
  mainAgentId: string;
  question: string;
  mode: ThreadMode;
  target: { kind: "continue"; threadId?: string } | { kind: "new" };
  model?: string;
  thinkingOptionId?: string | null;
  continuationOf?: string;
  sendBehavior: "auto" | "interrupt" | "steer";
  clientRequestId?: string;
}

export interface AskResult {
  threadId: string;
  agentId: string;
  created: boolean;
}

export async function askThread(paseo: PaseoApi, settings: SidekickSettings, input: AskInput): Promise<AskResult> {
  await registry.ensureLoaded();

  if (input.clientRequestId) {
    const knownId = registry.lookupRequestId(input.clientRequestId);
    const known = knownId ? registry.getThread(knownId) : undefined;
    if (known) return { threadId: known.id, agentId: known.agentId, created: false };
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

  if (input.target.kind === "continue") {
    const thread = input.target.threadId
      ? registry.getThread(input.target.threadId)
      : registry.findLastActive(input.mainAgentId, input.mode);
    if (thread) {
      if (thread.state !== "open") {
        throw new Error("该侧聊已停止：可「重建并继续」，或用 /btw-new 新开线程");
      }
      return continueThread(paseo, settings, thread, input, contextMode);
    }
  }

  await assertConcurrency(paseo, settings, input.mode);
  const record = await createThread(paseo, settings, {
    mainAgentId: input.mainAgentId,
    workspaceId: main.workspaceId,
    provider,
    model,
    mode: input.mode,
    thinkingOptionId: input.thinkingOptionId ?? null,
    mainModeId: main.currentModeId ?? null,
    question: input.question,
    contextMode,
    seedFromAgentId: input.continuationOf ?? null,
  });
  if (input.clientRequestId) registry.rememberRequestId(input.clientRequestId, record.id);
  return { threadId: record.id, agentId: record.agentId, created: true };
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
  if (busy && input.sendBehavior === "auto") {
    throw new Error("侧聊正在回答中：可选择「打断并发」「追加引导」，或用 /btw-new 新开线程");
  }

  const attachments: OutgoingTextAttachment[] = [];
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
        registry.upsertThread({
          ...thread,
          syncCursor: { unitsSeen: tail.units.length, messagesSeen: tail.messagesSeen },
        });
      } else {
        const increment = buildIncrementText(tail, thread.syncCursor, settings.includeActionDigest);
        if (increment) {
          attachments.push(textAttachment("主会话增量更新.md", increment.text));
          registry.upsertThread({ ...thread, syncCursor: increment.cursor });
        }
      }
    } catch (error) {
      console.error("[bytheway] passive sync failed", message(error));
    }
  }

  // 模型切换：仅限同一 Provider，通过辅助 agent 调 MCP update_agent 原地生效
  let nextModel = thread.model;
  if (input.model) {
    const desired = splitModel(input.model);
    if (desired.provider && desired.provider !== thread.provider) {
      throw new Error("已有侧聊不能切换 provider：请用 /btw-new 新开线程再选其它 provider");
    }
    if (desired.model !== thread.model) {
      const switched = await switchThreadModel(paseo, thread, desired.model);
      if (!switched.ok) {
        throw new Error(`模型切换失败：${switched.error ?? "未知原因"}`);
      }
      nextModel = desired.model;
      console.log(`[bytheway] thread ${thread.id} model switched to ${nextModel}`);
    }
  }

  // 就地模式切换：聊天/干活切换不再新开线程，改为随消息携带切换指令并更新线程模式
  const modeChanged = input.mode !== thread.mode;
  let messageText = input.question;
  if (modeChanged) {
    const prompts = settings.language === "en" ? MODE_SWITCH_PROMPTS.en : MODE_SWITCH_PROMPTS.zh;
    const directive = input.mode === "work" ? prompts.toWork : prompts.toAsk;
    messageText = `${directive}\n\n${input.question}`;
  }

  const sendOptions = {
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(busy
      ? { activeTurnBehavior: input.sendBehavior === "steer" ? ("steer" as const) : ("interrupt" as const) }
      : {}),
  };
  await handle.send(messageText, sendOptions);
  registry.upsertThread({
    ...thread,
    mode: modeChanged ? input.mode : thread.mode,
    model: nextModel,
    updatedAt: Date.now(),
  });
  console.log(
    `[bytheway] thread ${thread.id} ${modeChanged ? `mode switched to ${input.mode}` : "continued"}`,
  );
  return { threadId: thread.id, agentId: thread.agentId, created: false };
}

interface CreateThreadInput {
  mainAgentId: string;
  workspaceId: string;
  provider: string;
  model: string;
  mode: ThreadMode;
  thinkingOptionId: string | null;
  mainModeId: string | null;
  question: string;
  contextMode: ContextModeInfo;
  seedFromAgentId: string | null;
}

async function createThread(
  paseo: PaseoApi,
  settings: SidekickSettings,
  input: CreateThreadInput,
): Promise<ThreadRecord> {
  const threadId = registry.newThreadId();
  const modeId =
    input.mode === "ask" ? await pickReadOnlyMode(paseo, input.provider) : input.mainModeId ?? undefined;
  const systemPrompt = buildSystemPrompt({
    mainAgentId: input.mainAgentId,
    mode: input.mode,
    toolsAvailable: input.contextMode.toolsAvailable,
    passive: input.contextMode.passive,
  });

  const attachments: OutgoingTextAttachment[] = [];
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

  // 接续线程（换模型/模式后新开）：让新线程先读取旧线程的上下文
  let prompt = input.question;
  if (input.seedFromAgentId) {
    if (input.contextMode.toolsAvailable) {
      prompt = `这是一条接续的侧聊线程（用户更换了模型或模式）。请先调用 MCP 工具 get_agent_activity 读取 agent ${input.seedFromAgentId} 的最近活动，了解先前对话的结论与语气，然后处理：\n\n${input.question}`;
    } else {
      try {
        const tail = await fetchTranscriptTail(paseo, input.seedFromAgentId, 80);
        attachments.push(
          textAttachment(
            "接续速记.md",
            `以下为前一条侧聊线程的历史摘要（接续用）：\n\n${buildSnapshotText(tail, {
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

  const title = `${input.mode === "work" ? "[侧聊·Build]" : "[侧聊]"} ${truncateOneLine(input.question)}`;
  const handle = await paseo.workspaces.ref(input.workspaceId).agents.create({
    config: {
      provider: input.model ? `${input.provider}/${input.model}` : input.provider,
      ...(modeId ? { modeId } : {}),
      ...(input.thinkingOptionId ? { thinkingOptionId: input.thinkingOptionId } : {}),
      systemPrompt,
    },
    title,
    prompt,
    ...(attachments.length > 0 ? { attachments } : {}),
    labels: { sidekick: "1", "sidekick.thread": threadId, "sidekick.main": input.mainAgentId },
    ...(settings.attachToMain ? { parent: input.mainAgentId } : {}),
  });

  const now = Date.now();
  const record: ThreadRecord = {
    id: threadId,
    mainAgentId: input.mainAgentId,
    workspaceId: input.workspaceId,
    agentId: handle.id,
    title,
    mode: input.mode,
    provider: input.provider,
    model: input.model,
    thinkingOptionId: input.thinkingOptionId,
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

/** 通过辅助 agent 调用 MCP update_agent，把线程 agent 的模型原地切换到目标模型。 */
async function switchThreadModel(
  paseo: PaseoApi,
  thread: ThreadRecord,
  modelId: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const helper = await paseo.workspaces.ref(thread.workspaceId).agents.create({
      config: { provider: thread.model ? `${thread.provider}/${thread.model}` : thread.provider },
      title: "[侧聊·切换模型]",
      labels: { sidekick: "helper" },
    });
    try {
      const result = await helper.run(
        `请调用 MCP 工具 update_agent，参数 agentId="${thread.agentId}"、model="${modelId}"，把该 agent 的模型切换为 ${modelId}。成功后只回复：done；如果 update_agent 工具不可用，只回复：tool-unavailable。`,
        { timeoutMs: 60_000 },
      );
      if ((result.lastMessage ?? "").toLowerCase().includes("tool-unavailable")) {
        return { ok: false, error: "Paseo 工具不可用（需开启 daemon.mcp.injectIntoAgents）" };
      }
      const snapshot = await paseo.agents.ref(thread.agentId).refresh();
      if (snapshot?.agent.model === modelId) return { ok: true };
      return { ok: false, error: `切换未生效（当前仍是 ${snapshot?.agent.model ?? "未知"}）` };
    } finally {
      void helper.archive().catch(() => {});
    }
  } catch (error) {
    return { ok: false, error: message(error) };
  }
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
          registry.upsertThread({ ...current, title });
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
  registry.removeThread(threadId);
}

export async function renameThread(threadId: string, title: string): Promise<void> {
  await registry.ensureLoaded();
  const thread = registry.getThread(threadId);
  if (!thread) throw new Error("线程不存在");
  registry.upsertThread({ ...thread, title: truncateOneLine(title, 120), updatedAt: Date.now() });
}

export async function pinThread(threadId: string, pinned: boolean): Promise<void> {
  await registry.ensureLoaded();
  const thread = registry.getThread(threadId);
  if (!thread) throw new Error("线程不存在");
  registry.upsertThread({ ...thread, pinned, updatedAt: Date.now() });
}

export async function rebuildThread(
  paseo: PaseoApi,
  settings: SidekickSettings,
  threadId: string,
  question?: string,
  modelOverride?: string,
): Promise<{ threadId: string; agentId: string }> {
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

  const oldAgentId = thread.agentId;
  const systemPrompt = buildSystemPrompt({
    mainAgentId: thread.mainAgentId,
    mode: thread.mode,
    toolsAvailable: contextMode.toolsAvailable,
    passive: contextMode.passive,
  });
  const seed = contextMode.toolsAvailable
    ? `这是一条被重建的侧聊线程。请先调用 MCP 工具 get_agent_activity 读取 agent ${oldAgentId} 的最近活动，了解该线程此前的问答与结论，继承其上下文与语气。然后继续处理：\n\n${question?.trim() || "（请简短总结此前的结论，然后等待用户的下一个问题。）"}`
    : `这是一条被重建的侧聊线程。\n\n${question?.trim() || "（请等待用户的下一个问题。）"}`;

  const attachments: OutgoingTextAttachment[] = [];
  if (!contextMode.toolsAvailable) {
    try {
      const tail = await fetchTranscriptTail(paseo, oldAgentId, 80);
      attachments.push(
        textAttachment(
          "旧线程速记.md",
          `以下为该侧聊线程被重建前的历史摘要（可能不完整）：\n\n${buildSnapshotText(tail, {
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

  const modeId = thread.mode === "ask" ? await pickReadOnlyMode(paseo, provider) : undefined;
  const handle = await paseo.workspaces.ref(thread.workspaceId).agents.create({
    config: {
      provider: model ? `${provider}/${model}` : provider,
      ...(modeId ? { modeId } : {}),
      ...(thread.thinkingOptionId ? { thinkingOptionId: thread.thinkingOptionId } : {}),
      systemPrompt,
    },
    title: thread.title,
    prompt: seed,
    ...(attachments.length > 0 ? { attachments } : {}),
    labels: { sidekick: "1", "sidekick.thread": thread.id, "sidekick.main": thread.mainAgentId },
    ...(settings.attachToMain ? { parent: thread.mainAgentId } : {}),
  });

  registry.upsertThread({
    ...thread,
    agentId: handle.id,
    provider,
    model,
    state: "open",
    stateReason: null,
    updatedAt: Date.now(),
    syncCursor: null,
  });
  console.log(`[bytheway] thread ${thread.id} rebuilt (agent ${handle.id})`);
  return { threadId: thread.id, agentId: handle.id };
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
  } catch (error) {
    console.error("[bytheway] reaper failed", message(error));
  }
}

/** 列表前轻量刷状态：会话不存在/已归档 → stopped；同时收集各线程运行时状态。 */
export async function refreshThreadStates(
  paseo: PaseoApi,
  mainAgentId: string,
): Promise<Record<string, ThreadRuntimeStatus>> {
  const statuses: Record<string, ThreadRuntimeStatus> = {};
  const threads = registry.listThreads(mainAgentId).slice(0, 12);
  await Promise.allSettled(
    threads.map(async (thread) => {
      if (thread.state !== "open") {
        statuses[thread.id] = "closed";
        return;
      }
      try {
        const snapshot = await paseo.agents.ref(thread.agentId).refresh();
        const agent = snapshot?.agent;
        if (!agent) {
          registry.upsertThread({ ...thread, state: "stopped", stateReason: "会话不存在" });
          statuses[thread.id] = "closed";
        } else if (agent.archivedAt) {
          registry.upsertThread({ ...thread, state: "stopped", stateReason: "已归档" });
          statuses[thread.id] = "closed";
        } else {
          statuses[thread.id] = agent.status;
        }
      } catch {
        statuses[thread.id] = "idle";
      }
    }),
  );
  return statuses;
}
