import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { PROMPT_MARKERS } from "../shared/prompt-markers";
import type { ThreadMode } from "../shared/types";
import { snapshotFeatureValues } from "../shared/controls";

export type PaseoApi = PluginHandlerContext["paseo"];
type AgentHandle = ReturnType<PaseoApi["agents"]["ref"]>;
type TimelinePage = Awaited<ReturnType<AgentHandle["timeline"]["refetch"]>>;
export type TimelineEntry = TimelinePage["entries"][number];
export type TimelineItem = TimelineEntry["item"];

/* ------------------------------------------------------------------ */
/* 转录线性化（消息 + 工具动作）                                          */
/* ------------------------------------------------------------------ */

export type ToolTier = "change" | "info" | "minor";

export interface TranscriptUnit {
  kind: "user" | "assistant" | "tool";
  /** 消息：原文（未截断）；工具：摘要行（已按分级截断）。 */
  text: string;
  tier?: ToolTier;
}

export interface TranscriptTail {
  units: TranscriptUnit[];
  messagesSeen: number;
  /** 尾部页已触及 limit，无法保证游标可靠。 */
  unreliable: boolean;
}

const MAX_CHARS_PER_MESSAGE = 1500;
export const SNAPSHOT_BUDGET = 8000;
export const DIGEST_BUDGET = 2000;
export const PASSIVE_SNAPSHOT_MESSAGES = 12;
export const PASSIVE_SNAPSHOT_BUDGET = 12000;
export const INCREMENT_MESSAGES = 3;
export const INCREMENT_BUDGET = 3000;

function truncate(text: string, max: number): string {
  const clean = text.trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max)}…`;
}

function diffStat(unifiedDiff: string | undefined): { stat: string; hunk: string } {
  if (!unifiedDiff) return { stat: "", hunk: "" };
  let plus = 0;
  let minus = 0;
  let hunk = "";
  for (const line of unifiedDiff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) plus += 1;
    else if (line.startsWith("-")) minus += 1;
    else if (!hunk && line.startsWith("@@")) hunk = line.slice(0, 80);
  }
  const stat = plus || minus ? ` +${plus}/-${minus}` : "";
  return { stat, hunk };
}

const CHANGE_SHELL_RE =
  /(^|\s|\||;|&&)(rm|mv|cp|mkdir|touch|chmod|chown|kill|pkill|git\s+(commit|push|merge|rebase|reset|checkout|switch|add)|npm\s+(install|i|publish|uninstall)|pnpm|yarn|cargo|go\s+(build|test|run)|make|docker|kubectl|curl|wget|ssh|scp|git\s+stash)/i;

function toolUnit(item: Extract<TimelineItem, { type: "tool_call" }>): TranscriptUnit {
  const failed = item.status === "failed" ? "（失败）" : item.status === "canceled" ? "（取消）" : "";
  const detail = item.detail;
  let line: string;
  let tier: ToolTier = "minor";

  switch (detail.type) {
    case "edit": {
      const { stat, hunk } = diffStat(detail.unifiedDiff);
      line = `- [edit] ${detail.filePath}${stat}${hunk ? ` ${hunk}` : ""}${failed}`;
      tier = "change";
      break;
    }
    case "write": {
      line = `- [write] ${detail.filePath}${failed}`;
      tier = "change";
      break;
    }
    case "shell": {
      const change = CHANGE_SHELL_RE.test(detail.command);
      line = `- [shell] ${detail.command}${failed}`;
      tier = change ? "change" : "info";
      break;
    }
    case "read": {
      line = `- [read] ${detail.filePath}${failed}`;
      tier = "info";
      break;
    }
    case "search": {
      line = `- [search] ${detail.query}${detail.content ? "（有结果）" : ""}${failed}`;
      tier = "info";
      break;
    }
    default: {
      line = `- [${item.name}]${failed}`;
      tier = "minor";
      break;
    }
  }

  const cap = tier === "change" ? 200 : tier === "info" ? 150 : 30;
  return { kind: "tool", text: truncate(line, cap), tier };
}

/** 读取主会话转录尾部并线性化为「消息 + 工具动作」序列。 */
export async function fetchTranscriptTail(
  paseo: PaseoApi,
  agentId: string,
  limit = 100,
): Promise<TranscriptTail> {
  const page = await paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", limit });
  const units: TranscriptUnit[] = [];
  let messagesSeen = 0;
  for (const entry of page.entries) {
    const item = entry.item;
    if (item.type === "user_message") {
      units.push({ kind: "user", text: item.text });
      messagesSeen += 1;
    } else if (item.type === "assistant_message") {
      units.push({ kind: "assistant", text: item.text });
      messagesSeen += 1;
    } else if (item.type === "tool_call") {
      units.push(toolUnit(item));
    }
  }
  return { units, messagesSeen, unreliable: page.entries.length >= limit };
}

/* ------------------------------------------------------------------ */
/* 文本构建                                                             */
/* ------------------------------------------------------------------ */

const TIER_PRIORITY: Record<ToolTier, number> = { change: 0, info: 1, minor: 2 };

export function buildDigestLines(
  units: TranscriptUnit[],
  budget = DIGEST_BUDGET,
): string[] {
  const tools = units.filter((unit) => unit.kind === "tool");
  // 最近的动作优先（同优先级内），再按分级排序，最后按预算装配
  const indexed = tools.map((unit, index) => ({ unit, index }));
  indexed.sort((a, b) => {
    const tierDelta = TIER_PRIORITY[a.unit.tier ?? "minor"] - TIER_PRIORITY[b.unit.tier ?? "minor"];
    if (tierDelta !== 0) return tierDelta;
    return b.index - a.index;
  });
  const kept: Array<{ text: string; index: number }> = [];
  let used = 0;
  for (const { unit, index } of indexed) {
    const cost = unit.text.length + 1;
    if (used + cost > budget) continue;
    used += cost;
    kept.push({ text: unit.text, index });
  }
  kept.sort((a, b) => a.index - b.index);
  return kept.map((entry) => entry.text);
}

export function buildSnapshotText(
  tail: TranscriptTail,
  options: { messages: number; includeDigest: boolean; budget?: number; passive?: boolean },
): string {
  const budget = options.budget ?? SNAPSHOT_BUDGET;
  const messageUnits = tail.units.filter((unit) => unit.kind !== "tool");
  const recent = messageUnits.slice(-Math.max(0, options.messages));
  const lines: string[] = [];
  let used = 0;
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const unit = recent[i];
    const role = unit.kind === "user" ? "用户" : "助手";
    const rendered = `${role}: ${truncate(unit.text, MAX_CHARS_PER_MESSAGE)}`;
    if (used + rendered.length > budget && lines.length > 0) break;
    used += rendered.length;
    lines.unshift(rendered);
  }

  const digestLines = options.includeDigest ? buildDigestLines(tail.units) : [];
  const parts: string[] = [
    `${PROMPT_MARKERS.mainSnapshot}（生成于 ${new Date().toISOString()}）。${
      options.passive
        ? "本线程处于被动同步模式：后续主会话有新的进展时，系统会自动在消息中附上增量更新。"
        : "如需主会话的最新进展，请调用 get_agent_activity 工具按需查询。"
    }`,
  ];
  if (lines.length > 0) parts.push(`### 最近消息\n${lines.join("\n\n")}`);
  if (digestLines.length > 0) parts.push(`### 最近动作\n${digestLines.join("\n")}`);
  if (lines.length === 0 && digestLines.length === 0) parts.push("（主会话暂无可用记录，请直接根据问题回答。）");
  return parts.join("\n\n");
}

export interface SyncCursor {
  unitsSeen: number;
  messagesSeen: number;
}

export interface IncrementResult {
  text: string;
  cursor: SyncCursor;
}

/** 被动同步模式：构建「主会话增量更新」。返回 null 表示没有新内容。 */
export function buildIncrementText(
  tail: TranscriptTail,
  cursor: SyncCursor | null,
  includeDigest: boolean,
): IncrementResult | null {
  const start = cursor?.unitsSeen ?? 0;
  if (start >= tail.units.length) return null;
  const fresh = tail.units.slice(start);
  const freshMessages = fresh.filter((unit) => unit.kind !== "tool").slice(-INCREMENT_MESSAGES);
  const digestLines = includeDigest ? buildDigestLines(fresh, 800) : [];
  if (freshMessages.length === 0 && digestLines.length === 0) return null;

  const lines: string[] = [];
  let used = 0;
  for (let i = freshMessages.length - 1; i >= 0; i -= 1) {
    const unit = freshMessages[i];
    const role = unit.kind === "user" ? "用户" : "助手";
    const rendered = `${role}: ${truncate(unit.text, 1000)}`;
    if (used + rendered.length > INCREMENT_BUDGET && lines.length > 0) break;
    used += rendered.length;
    lines.unshift(rendered);
  }
  const parts = [`${PROMPT_MARKERS.mainIncrement}（增量更新，生成于 ${new Date().toISOString()}）。`];
  if (lines.length > 0) parts.push(lines.join("\n\n"));
  if (digestLines.length > 0) parts.push(`### 新动作\n${digestLines.join("\n")}`);
  return {
    text: parts.join("\n\n"),
    cursor: { unitsSeen: tail.units.length, messagesSeen: tail.messagesSeen },
  };
}

/* ------------------------------------------------------------------ */
/* 系统提示词                                                            */
/* ------------------------------------------------------------------ */

export interface SystemPromptOptions {
  mainAgentId: string;
  mode: ThreadMode | "provider";
  toolsAvailable: boolean;
  passive: boolean;
}

export function buildSystemPrompt(options: SystemPromptOptions): string {
  const { mainAgentId, mode, toolsAvailable, passive } = options;
  const contextLine = toolsAvailable
    ? `主会话的 agent id 是 ${mainAgentId}。当你需要了解主会话的最新进展（用户正在做什么、最近改了什么）时，调用 MCP 工具 get_agent_activity（传入该 id）读取其最近活动摘要；需要状态时用 get_agent_status。不要凭空猜测主会话的内容。`
    : passive
      ? `主会话的上下文会由系统以附件形式同步给你（被动同步模式），最近进展以附件为准。`
      : `回答时如缺少主会话信息，请明确说明而不猜测。`;
  const modeLine =
    mode === "ask"
      ? "你处于只读建议模式：不要修改文件、不要执行有副作用的命令；可以读取文件与搜索，用于给出准确的回答。"
      : mode === "provider"
        ? "遵循当前 Paseo provider mode 的权限约束；不要尝试绕过该模式的限制。"
        : "你可以执行任务所需的操作；保持改动最小、聚焦，不做无关重构。";
  return [
    "你是 Paseo「侧聊（ByTheWay）」会话：用户在自己的主会话之外向你提出旁路问题或小任务；你的回答只展示给用户，不会自动写入主会话。",
    contextLine,
    modeLine,
    "回答保持聚焦、简洁、结构清晰，使用与用户问题相同的语言。",
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* 主会话 agent 配置继承                                                  */
/* ------------------------------------------------------------------ */

/** 提取主会话/agent 快照 features 的原始值；实现由 shared/controls 统一维护。 */
export function featuresToValues(
  features: ReadonlyArray<{ id: string; value?: boolean | string | null }> | null | undefined,
): Record<string, unknown> {
  return snapshotFeatureValues(features);
}

/* ------------------------------------------------------------------ */
/* 能力探测                                                              */
/* ------------------------------------------------------------------ */

let toolsCache: { value: boolean; at: number } | null = null;

/** 探测 Paseo 工具注入是否开启（60 秒缓存）。 */
export async function detectToolsAvailable(paseo: PaseoApi): Promise<boolean> {
  if (toolsCache && Date.now() - toolsCache.at < 60_000) return toolsCache.value;
  try {
    const { config } = await paseo.config.get();
    const injected =
      (config as { daemon?: { mcp?: { injectIntoAgents?: boolean } } }).daemon?.mcp
        ?.injectIntoAgents === true;
    toolsCache = { value: injected, at: Date.now() };
    return injected;
  } catch {
    return toolsCache?.value ?? true;
  }
}

type ModeChoice = { id: string; label: string; colorTier?: string };

function isPlanMode(mode: { id: string; label: string }): boolean {
  return /plan|read.?only|read-only/i.test(`${mode.id} ${mode.label}`);
}

/** 为只执行 Paseo 管理工具的临时辅助 agent 选择无人值守模式。 */
export function chooseUnattendedMode(modes: readonly ModeChoice[]): string | undefined {
  const dangerous = modes.find((mode) => mode.colorTier === "dangerous");
  if (dangerous) return dangerous.id;
  const bypass = modes.find((mode) => /bypass|full.?access|yolo/i.test(`${mode.id} ${mode.label}`));
  if (bypass) return bypass.id;
  const auto = modes.find((mode) => /auto/i.test(`${mode.id} ${mode.label}`));
  if (auto) return auto.id;
  const build = modes.find((mode) => /build|accept|edit|code|exec/i.test(`${mode.id} ${mode.label}`));
  if (build) return build.id;
  return modes.find((mode) => !isPlanMode(mode))?.id;
}

export async function pickUnattendedMode(paseo: PaseoApi, provider: string): Promise<string | undefined> {
  try {
    const result = await paseo.providers.listModes(provider);
    return chooseUnattendedMode(result.modes ?? []);
  } catch {
    return undefined;
  }
}
