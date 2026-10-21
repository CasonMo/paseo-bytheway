import { createContext, useContext, type ReactNode } from "react";
import { NativeModules, Platform } from "react-native";

export type Lang = "zh" | "en";

/* ------------------------------------------------------------------ */
/* 语言探测                                                             */
/* ------------------------------------------------------------------ */

export function detectLang(): Lang {
  try {
    if (Platform.OS === "ios") {
      const settings = NativeModules.SettingsManager?.settings as
        | { AppleLocale?: string; AppleLanguages?: string[] }
        | undefined;
      const locale = settings?.AppleLocale ?? settings?.AppleLanguages?.[0];
      if (typeof locale === "string") return locale.toLowerCase().startsWith("zh") ? "zh" : "en";
    } else if (Platform.OS === "android") {
      const locale = (NativeModules.I18nManager as { localeIdentifier?: string } | undefined)
        ?.localeIdentifier;
      if (typeof locale === "string") return locale.toLowerCase().startsWith("zh") ? "zh" : "en";
    } else if (Platform.OS === "web") {
      const locale = typeof navigator !== "undefined" ? navigator.language : null;
      if (locale) return locale.toLowerCase().startsWith("zh") ? "zh" : "en";
    }
  } catch {
    // fall through
  }
  return "zh";
}

export function resolveLang(setting: "auto" | "zh" | "en" | null | undefined): Lang {
  if (setting === "zh" || setting === "en") return setting;
  return detectLang();
}

/* ------------------------------------------------------------------ */
/* 面板 / 条目 文案                                                     */
/* ------------------------------------------------------------------ */

export interface UIStrings {
  // 通用
  close: string;
  cancel: string;
  save: string;
  copy: string;
  copied: string;
  copyFailed: string;
  expand: string;
  collapse: string;
  expandAll: string;
  processing: string;

  // 连接状态
  connLive: string;
  connRestored: string;
  connError: string;
  connConnecting: string;

  // 线程状态
  statusRunning: string;
  statusIdle: string;
  statusInitializing: string;
  statusError: string;
  statusStopped: string;

  // 头部 / 线程
  panelTitle: string;
  noThreads: string;
  moreSessions: string;
  openTab: string;
  willNewThreadShort: string;

  // 空态
  emptyTitle: string;
  emptyBody: string;
  emptyTranscript: string;
  thinking: string;
  stoppedThread: (reason: string) => string;
  stoppedThreadHint: string;

  // 输入区
  inputPlaceholderContinue: string;
  inputPlaceholderNew: string;
  send: string;
  sending: string;
  stop: string;
  stopping: string;
  busyHint: string;
  willSendTo: (title: string) => string;
  willSwitchMode: (mode: string) => string;
  willSwitchModel: (model: string) => string;
  providerLocked: (provider: string) => string;
  willRebuild: string;
  willNewThreadChanged: string;
  willNewThread: string;
  jumpToBottom: string;

  // 线程/模型/重命名弹层
  threadsSheet: string;
  searchThreads: string;
  noThreadMatches: string;
  currentBadge: string;
  rename: string;
  archive: string;
  renameSheet: string;
  threadNamePlaceholder: string;
  modelsSheet: string;
  modelsSheetHint: string;
  searchModels: string;
  followMain: string;
  noModels: string;
  settingsFallbackHint: string;

  // Toast / 提示
  stoppedToast: string;
  archivedToast: string;
  archiveFailed: (error: string) => string;
  renamedToast: string;
  renameFailed: (error: string) => string;
  permissionFailed: (error: string) => string;
  stopIneffective: string;

  // turn 状态行
  answering: string;
  answeringElapsed: (elapsed: string) => string;
  timePrefix: string;
  failedPrefix: (error: string) => string;
  canceled: string;

  // 权限
  permissionTitle: string;
  toolRequest: string;
  allow: string;
  deny: string;

  // 条目
  reasoningRunning: string;
  reasoning: string;
  toolRunning: string;
  toolCompleted: string;
  toolFailed: string;
  toolCanceled: string;
  compactionLoading: string;
  compactionDone: string;

  // Markdown
  codeMeta: (lang: string, lines: number) => string;
  codeCopied: string;
  linkCopied: string;
  linkOpenFailed: string;
}

const zh: UIStrings = {
  close: "关闭",
  cancel: "取消",
  save: "保存",
  copy: "复制",
  copied: "已复制",
  copyFailed: "复制失败",
  expand: "展开",
  collapse: "收起",
  expandAll: "展开全部",
  processing: "处理中…",

  connLive: "实时",
  connRestored: "重连中",
  connError: "连接异常",
  connConnecting: "连接中",

  statusRunning: "回答中",
  statusIdle: "就绪",
  statusInitializing: "启动中",
  statusError: "异常",
  statusStopped: "已停止",

  panelTitle: "ByTheWay 侧聊",
  noThreads: "尚无侧聊线程——在下方输入开始第一条",
  moreSessions: "更多会话",
  openTab: "标签页",
  willNewThreadShort: "将新开线程",

  emptyTitle: "从主会话旁路提问，不打扰主会话",
  emptyBody: "在下方输入即可开始；或在主会话输入 /btw、/btw-new 快速开聊。\n侧聊的执行过程会在这里实时直播（文本 / 工具 / 思考 / 权限）。",
  emptyTranscript: "暂无消息——发送第一条问题开始直播。",
  thinking: "正在思考…",
  stoppedThread: (reason) => `该侧聊已停止（${reason}）`,
  stoppedThreadHint: "可直接在下方发送：系统会「重建并继续」这条线程（会继承历史结论）。",

  inputPlaceholderContinue: "输入侧聊问题…",
  inputPlaceholderNew: "输入问题，开始新的侧聊…",
  send: "发送",
  sending: "发送中…",
  stop: "停止",
  stopping: "停止中…",
  busyHint: "正在回答中：可停止，或点右上 ＋ 后发送以新开线程",
  willSendTo: (title) => `将发送到「${title}」`,
  willSwitchMode: (mode) => `将切换该线程为 ${mode} 模式`,
  willSwitchModel: (model) => `将原地切换该线程模型为 ${model}（约需几秒）`,
  providerLocked: (provider) => `Provider 已固定：${provider}（会话创建时确定；换 Provider 请新开线程）`,
  willRebuild: "将「重建并继续」这条线程（继承历史结论）",
  willNewThreadChanged: "将新开接续线程（继承当前线程上下文）",
  willNewThread: "将新开线程",
  jumpToBottom: "回到底部 ↓",

  threadsSheet: "侧聊线程",
  searchThreads: "搜索线程…",
  noThreadMatches: "没有匹配的线程。",
  currentBadge: "当前",
  rename: "重命名",
  archive: "归档",
  renameSheet: "重命名线程",
  threadNamePlaceholder: "线程名称",
  modelsSheet: "选择模型（用于新线程）",
  modelsSheetHint: "已有线程仅可切换同一 Provider 的模型（原地生效）；新建线程可跨 Provider 选择",
  searchModels: "搜索模型…",
  followMain: "跟随主会话",
  noModels: "没有可用模型。",
  settingsFallbackHint: "请在「设置 → 插件 → ByTheWay 侧聊」中打开设置",

  stoppedToast: "已停止",
  archivedToast: "线程已停止并归档",
  archiveFailed: (error) => `归档失败：${error}`,
  renamedToast: "已重命名",
  renameFailed: (error) => `重命名失败：${error}`,
  permissionFailed: (error) => `权限处理失败：${error}`,
  stopIneffective: "取消未在 5 秒内生效：可打开标签页用原生按钮停止",

  answering: "正在回答中…",
  answeringElapsed: (elapsed) => `正在回答… 已用 ${elapsed}`,
  timePrefix: "用时",
  failedPrefix: (error) => `已失败：${error}`,
  canceled: "已取消",

  permissionTitle: "需要权限确认",
  toolRequest: "工具请求",
  allow: "允许",
  deny: "拒绝",

  reasoningRunning: "思考中…",
  reasoning: "思考",
  toolRunning: "运行中",
  toolCompleted: "完成",
  toolFailed: "失败",
  toolCanceled: "取消",
  compactionLoading: "上下文压缩中…",
  compactionDone: "上下文已压缩",

  codeMeta: (lang, lines) => `${lang || "code"} · ${lines} 行`,
  codeCopied: "代码已复制",
  linkCopied: "链接已复制",
  linkOpenFailed: "无法打开链接",
};

const en: UIStrings = {
  close: "Close",
  cancel: "Cancel",
  save: "Save",
  copy: "Copy",
  copied: "Copied",
  copyFailed: "Copy failed",
  expand: "Expand",
  collapse: "Collapse",
  expandAll: "Expand all",
  processing: "Working…",

  connLive: "Live",
  connRestored: "Reconnecting",
  connError: "Connection error",
  connConnecting: "Connecting",

  statusRunning: "Answering",
  statusIdle: "Ready",
  statusInitializing: "Starting",
  statusError: "Error",
  statusStopped: "Stopped",

  panelTitle: "ByTheWay",
  noThreads: "No side threads yet — type below to start one",
  moreSessions: "More",
  openTab: "Tab",
  willNewThreadShort: "will start a new thread",

  emptyTitle: "Ask on the side without disturbing the main session",
  emptyBody: "Type below to start, or use /btw or /btw-new in the main composer.\nThe side agent's work streams here live (text / tools / thinking / permissions).",
  emptyTranscript: "No messages yet — send the first question to start streaming.",
  thinking: "Thinking…",
  stoppedThread: (reason) => `This side thread has stopped (${reason})`,
  stoppedThreadHint: "Send below to rebuild and continue this thread (it inherits prior conclusions).",

  inputPlaceholderContinue: "Ask something on the side…",
  inputPlaceholderNew: "Type a question to start a new side chat…",
  send: "Send",
  sending: "Sending…",
  stop: "Stop",
  stopping: "Stopping…",
  busyHint: "Still answering: stop it, or tap + to send as a new thread",
  willSendTo: (title) => `Will send to “${title}”`,
  willSwitchMode: (mode) => `Will switch this thread to ${mode} mode`,
  willSwitchModel: (model) => `Will switch this thread's model to ${model} in place (takes a few seconds)`,
  providerLocked: (provider) => `Provider locked: ${provider} (set when the thread was created; start a new thread to use another provider)`,
  willRebuild: "Will rebuild and continue this thread (inherits prior conclusions)",
  willNewThreadChanged: "Will start a continuation thread (inherits this thread's context)",
  willNewThread: "Will start a new thread",
  jumpToBottom: "Back to bottom ↓",

  threadsSheet: "Side Threads",
  searchThreads: "Search threads…",
  noThreadMatches: "No matching threads.",
  currentBadge: "Current",
  rename: "Rename",
  archive: "Archive",
  renameSheet: "Rename Thread",
  threadNamePlaceholder: "Thread name",
  modelsSheet: "Pick a model (for new threads)",
  modelsSheetHint: "Existing threads can only switch models within their own provider (in place); new threads can pick any provider.",
  searchModels: "Search models…",
  followMain: "Follow main session",
  noModels: "No models available.",
  settingsFallbackHint: "Open Settings → Plugins → ByTheWay to configure",

  stoppedToast: "Stopped",
  archivedToast: "Thread stopped and archived",
  archiveFailed: (error) => `Archive failed: ${error}`,
  renamedToast: "Renamed",
  renameFailed: (error) => `Rename failed: ${error}`,
  permissionFailed: (error) => `Permission handling failed: ${error}`,
  stopIneffective: "Cancel did not take effect in 5s — open the tab and stop it there",

  answering: "Answering…",
  answeringElapsed: (elapsed) => `Answering… ${elapsed} elapsed`,
  timePrefix: "Time",
  failedPrefix: (error) => `Failed: ${error}`,
  canceled: "Canceled",

  permissionTitle: "Permission required",
  toolRequest: "Tool request",
  allow: "Allow",
  deny: "Deny",

  reasoningRunning: "Thinking…",
  reasoning: "Thinking",
  toolRunning: "Running",
  toolCompleted: "Done",
  toolFailed: "Failed",
  toolCanceled: "Canceled",
  compactionLoading: "Compacting context…",
  compactionDone: "Context compacted",

  codeMeta: (lang, lines) => `${lang || "code"} · ${lines} lines`,
  codeCopied: "Code copied",
  linkCopied: "Link copied",
  linkOpenFailed: "Could not open link",
};

export const uiStrings: Record<Lang, UIStrings> = { zh, en };

/* ------------------------------------------------------------------ */
/* 设置页文案（zh → en 查表）                                            */
/* ------------------------------------------------------------------ */

const settingsEn: Record<string, string> = {
  "基本": "General",
  "界面语言": "Language",
  "自动": "Auto",
  "中文": "中文",
  "English": "English",
  "新线程默认": "New thread defaults",
  "影响 /btw、/side 新开线程时的默认选择。": "Defaults applied when /btw or /side starts a new thread.",
  "默认模式": "Default mode",
  "Chat（只读建议）": "Chat (read-only advice)",
  "Build（可执行任务）": "Build (can execute tasks)",
  "默认模型": "Default model",
  "follow = 跟随主会话；或填写 provider/model（如 codex/gpt-5.5）": "follow = follow the main session; or set provider/model (e.g. codex/gpt-5.5)",
  "上下文": "Context",
  "侧聊如何了解主会话。默认「id 直连」：侧聊通过 Paseo 工具按需读取主会话最新进展。": "How side chats learn about the main session. Default: linked by agent id — the side agent reads the latest progress via Paseo tools on demand.",
  "首轮快照深度": "First-turn snapshot depth",
  "关闭（纯直连）": "Off (pure linked)",
  "最近 6 条": "Last 6 messages",
  "最近 12 条": "Last 12 messages",
  "最近 30 条": "Last 30 messages",
  "动作摘要": "Action digest",
  "快照中附带最近工具动作摘要（变更类优先）": "Include a recent tool-action digest in the snapshot (changes first)",
  "兜底模式": "Fallback mode",
  "自动（工具不可用时被动同步）": "Auto (passive sync when tools unavailable)",
  "关闭": "Off",
  "线程": "Threads",
  "挂到主会话": "Attach to main session",
  "侧聊 agent 作为主会话的子 agent（便于归档联动与查找）": "Create side agents as children of the main session (easier cleanup and discovery)",
  "AI 生成线程标题": "AI thread titles",
  "标题生成模型": "Title generation model",
  "follow = 使用线程同款模型；或填写 provider/model（如 codex/gpt-5.5）": "follow = same model as the thread; or provider/model (e.g. codex/gpt-5.5)",
  "创建后用 AI 生成简短标题（手动改过的标题不会被覆盖）": "Generate a short title after creation (manual renames are never overwritten)",
  "权限": "Permissions",
  "权限策略": "Permission policy",
  "询问（默认）": "Ask (default)",
  "自动放行只读类": "Auto-allow read-only",
  "全部拒绝": "Deny all",
  "只读类超时自动拒绝（分钟）": "Read-only auto-deny timeout (min)",
  "写类超时自动拒绝（分钟）": "Write auto-deny timeout (min)",
  "0 = 不超时": "0 = never",
  "并发与停止": "Concurrency & stop",
  "Chat 并发上限": "Chat concurrency limit",
  "Build 并发上限": "Build concurrency limit",
  "总并发上限": "Total concurrency limit",
  "实验性取消": "Experimental cancel",
  "停止时先尝试 MCP 辅助取消，5 秒未生效自动降级「打开标签页停止」": "Try the MCP helper cancel first; fall back to stop-in-tab after 5s",
  "关于": "About",
  "加载设置中…": "Loading settings…",
  "设置数据无效：": "Invalid settings data: ",
  "保存失败：": "Save failed: ",
  "不打断主会话的旁路侧聊：实时执行流、多线程、agent 直连上下文。RPC 直连 daemon，转录不落盘。":
    "Side chats that never disturb the main session: live execution stream, threads, agent-linked context.",
};

export function settingsTr(lang: Lang, zhText: string): string {
  if (lang === "zh") return zhText;
  return settingsEn[zhText] ?? zhText;
}

/* ------------------------------------------------------------------ */
/* 注册文案（面板标题 / 命令）                                           */
/* ------------------------------------------------------------------ */

export interface RegStrings {
  panelTitle: string;
  settingsTitle: string;
  argQuestion: string;
  argTask: string;
  argFork: string;
  cmdOpenPanel: string;
  cmdSettings: string;
  slashBtw: string;
  slashBtwNew: string;
  slashSide: string;
  slashSideNew: string;
  slashFork: string;
  slashUsageBtw: string;
  slashUsageBtwNew: string;
  slashUsageSide: string;
  slashUsageSideNew: string;
}

export const regStrings: Record<Lang, RegStrings> = {
  zh: {
    panelTitle: "ByTheWay 侧聊",
    settingsTitle: "ByTheWay 侧聊",
    argQuestion: "<问题>",
    argTask: "<任务>",
    argFork: "[首条提示词]",
    cmdOpenPanel: "打开 ByTheWay",
    cmdSettings: "ByTheWay 设置",
    slashBtw: "侧聊：从主会话旁路提问（继续当前侧聊）",
    slashBtwNew: "侧聊：新开一条侧聊线程",
    slashSide: "侧聊 · Build：旁路执行小任务（继续当前 Build 线程）",
    slashSideNew: "侧聊 · Build：新开一条 Build 线程",
    slashFork: "把当前会话克隆成一个新的并行会话",
    slashUsageBtw: "用法：/btw <问题>；新开一条用 /btw-new",
    slashUsageBtwNew: "用法：/btw-new <问题>",
    slashUsageSide: "用法：/side <任务>；新开一条用 /side-new",
    slashUsageSideNew: "用法：/side-new <任务>",
  },
  en: {
    panelTitle: "ByTheWay",
    settingsTitle: "ByTheWay",
    argQuestion: "<question>",
    argTask: "<task>",
    argFork: "[first prompt]",
    cmdOpenPanel: "Open ByTheWay",
    cmdSettings: "ByTheWay settings",
    slashBtw: "Side chat: ask from the main session's context (continue current thread)",
    slashBtwNew: "Side chat: start a new thread",
    slashSide: "Side chat · Build: run a small task (continue current Build thread)",
    slashSideNew: "Side chat · Build: start a new Build thread",
    slashFork: "Clone this session into a new parallel session",
    slashUsageBtw: "Usage: /btw <question>; use /btw-new for a new thread",
    slashUsageBtwNew: "Usage: /btw-new <question>",
    slashUsageSide: "Usage: /side <task>; use /side-new for a new thread",
    slashUsageSideNew: "Usage: /side-new <task>",
  },
};

/* ------------------------------------------------------------------ */
/* Context                                                              */
/* ------------------------------------------------------------------ */

const I18nContext = createContext<UIStrings>(uiStrings.zh);

export function I18nProvider({ lang, children }: { lang: Lang; children: ReactNode }) {
  return <I18nContext.Provider value={uiStrings[lang]}>{children}</I18nContext.Provider>;
}

export function useT(): UIStrings {
  return useContext(I18nContext);
}

/** 把服务端返回的中文提示翻译为英文（仅覆盖常见几条，其他保留原文）。 */
export function localizeServerMessage(messageText: string, lang: Lang): string {
  if (lang === "zh") return messageText;
  if (messageText.includes("侧聊正在回答中")) {
    return "This side chat is still answering — interrupt or steer, or use /btw-new.";
  }
  if (messageText.includes("该侧聊已停止")) {
    return "This side thread has stopped — rebuild it to continue, or start a new one.";
  }
  if (messageText.includes("并发已达上限")) {
    return "Concurrency limit reached — wait for running side chats to finish.";
  }
  if (messageText.includes("线程不存在")) return "Thread not found.";
  if (messageText.includes("侧聊当前不在运行中")) return "Side chat is not running.";
  if (messageText.includes("已发起取消请求")) {
    return "Cancellation requested (experimental). If it does not take effect in 5s, open the tab to stop.";
  }
  if (messageText.includes("辅助取消发起失败")) return "Failed to request cancellation.";
  if (messageText.includes("不能切换 provider")) {
    return "An existing side chat cannot switch provider — start a new thread to use another provider.";
  }
  if (messageText.includes("模型切换失败")) {
    return "Model switch failed — try again, or start a new thread with the desired model.";
  }
  if (messageText.includes("Paseo 工具不可用")) {
    return "Paseo tools are unavailable on this host (enable daemon.mcp.injectIntoAgents).";
  }
  if (messageText.includes("主会话不存在")) return "Main session is unavailable.";
  return messageText;
}
