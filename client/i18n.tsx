import { useMemo } from "react";
import { useTranslation } from "@getpaseo/plugin/client";
import { messages } from "./messages";

export type { PluginMessage } from "@getpaseo/plugin/client";
export { messages };

export interface UIStrings {
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

  connLive: string;
  connRestored: string;
  connError: string;
  connConnecting: string;

  statusRunning: string;
  statusIdle: string;
  statusInitializing: string;
  statusError: string;
  statusStopped: string;

  panelTitle: string;
  noThreads: string;
  moreSessions: string;
  openTab: string;
  willNewThreadShort: string;

  emptyTitle: string;
  emptyBody: string;
  emptyTranscript: string;
  thinking: string;
  stoppedThread: (reason: string) => string;
  stoppedThreadHint: string;

  inputPlaceholderContinue: string;
  inputPlaceholderNew: string;
  send: string;
  sending: string;
  stop: string;
  stopping: string;
  busyHint: string;
  sentInterruptToast: string;
  willSendTo: (title: string) => string;
  willSwitchMode: (mode: string) => string;
  willSwitchModel: (model: string) => string;
  providerLocked: (provider: string) => string;
  willRebuild: string;
  willNewThreadChanged: string;
  willNewThread: string;
  jumpToBottom: string;

  threadsSheet: string;
  searchThreads: string;
  noThreadMatches: string;
  currentBadge: string;
  rename: string;
  copyId: string;
  archive: string;
  renameSheet: string;
  threadNamePlaceholder: string;
  modelsSheet: string;
  modelsSheetHint: string;
  searchModels: string;
  followMain: string;
  noModels: string;
  settingsFallbackHint: string;

  stoppedToast: string;
  archivedToast: string;
  archiveFailed: (error: string) => string;
  renamedToast: string;
  renameFailed: (error: string) => string;
  permissionFailed: (error: string) => string;
  stopIneffective: string;

  answering: string;
  answeringElapsed: (elapsed: string) => string;
  timePrefix: string;
  failedPrefix: (error: string) => string;
  canceled: string;

  permissionTitle: string;
  toolRequest: string;
  allow: string;
  deny: string;
  questionSubmit: string;
  questionClose: string;
  questionOther: string;
  questionPrev: string;
  questionNext: string;

  reasoningRunning: string;
  reasoning: string;
  toolRunning: string;
  toolCompleted: string;
  toolFailed: string;
  toolCanceled: string;
  compactionLoading: string;
  compactionDone: string;

  updateBannerTitle: string;
  updateBannerBody: (current: string, latest: string, paseo: string) => string;
  updateBannerDismiss: string;
}

/** 面板 / 条目文案：跟随宿主 App 语言。 */
export function useT(): UIStrings {
  const { t } = useTranslation(messages);
  return useMemo(
    () => ({
      close: t("close"),
      cancel: t("cancel"),
      save: t("save"),
      copy: t("copy"),
      copied: t("copied"),
      copyFailed: t("copyFailed"),
      expand: t("expand"),
      collapse: t("collapse"),
      expandAll: t("expandAll"),
      processing: t("processing"),

      connLive: t("connLive"),
      connRestored: t("connRestored"),
      connError: t("connError"),
      connConnecting: t("connConnecting"),

      statusRunning: t("statusRunning"),
      statusIdle: t("statusIdle"),
      statusInitializing: t("statusInitializing"),
      statusError: t("statusError"),
      statusStopped: t("statusStopped"),

      panelTitle: t("panelTitle"),
      noThreads: t("noThreads"),
      moreSessions: t("moreSessions"),
      openTab: t("openTab"),
      willNewThreadShort: t("willNewThreadShort"),

      emptyTitle: t("emptyTitle"),
      emptyBody: t("emptyBody"),
      emptyTranscript: t("emptyTranscript"),
      thinking: t("thinking"),
      stoppedThread: (reason: string) => t("stoppedThread", { reason }),
      stoppedThreadHint: t("stoppedThreadHint"),

      inputPlaceholderContinue: t("inputPlaceholderContinue"),
      inputPlaceholderNew: t("inputPlaceholderNew"),
      send: t("send"),
      sending: t("sending"),
      stop: t("stop"),
      stopping: t("stopping"),
      busyHint: t("busyHint"),
      sentInterruptToast: t("sentInterruptToast"),
      willSendTo: (title: string) => t("willSendTo", { title }),
      willSwitchMode: (mode: string) => t("willSwitchMode", { mode }),
      willSwitchModel: (model: string) => t("willSwitchModel", { model }),
      providerLocked: (provider: string) => t("providerLocked", { provider }),
      willRebuild: t("willRebuild"),
      willNewThreadChanged: t("willNewThreadChanged"),
      willNewThread: t("willNewThread"),
      jumpToBottom: t("jumpToBottom"),

      threadsSheet: t("threadsSheet"),
      searchThreads: t("searchThreads"),
      noThreadMatches: t("noThreadMatches"),
      currentBadge: t("currentBadge"),
      rename: t("rename"),
      copyId: t("copyId"),
      archive: t("archive"),
      renameSheet: t("renameSheet"),
      threadNamePlaceholder: t("threadNamePlaceholder"),
      modelsSheet: t("modelsSheet"),
      modelsSheetHint: t("modelsSheetHint"),
      searchModels: t("searchModels"),
      followMain: t("followMain"),
      noModels: t("noModels"),
      settingsFallbackHint: t("settingsFallbackHint"),

      stoppedToast: t("stoppedToast"),
      archivedToast: t("archivedToast"),
      archiveFailed: (error: string) => t("archiveFailed", { error }),
      renamedToast: t("renamedToast"),
      renameFailed: (error: string) => t("renameFailed", { error }),
      permissionFailed: (error: string) => t("permissionFailed", { error }),
      stopIneffective: t("stopIneffective"),

      answering: t("answering"),
      answeringElapsed: (elapsed: string) => t("answeringElapsed", { elapsed }),
      timePrefix: t("timePrefix"),
      failedPrefix: (error: string) => t("failedPrefix", { error }),
      canceled: t("canceled"),

      permissionTitle: t("permissionTitle"),
      toolRequest: t("toolRequest"),
      allow: t("allow"),
      deny: t("deny"),
      questionSubmit: t("questionSubmit"),
      questionClose: t("questionClose"),
      questionOther: t("questionOther"),
      questionPrev: t("questionPrev"),
      questionNext: t("questionNext"),

      reasoningRunning: t("reasoningRunning"),
      reasoning: t("reasoning"),
      toolRunning: t("toolRunning"),
      toolCompleted: t("toolCompleted"),
      toolFailed: t("toolFailed"),
      toolCanceled: t("toolCanceled"),
      compactionLoading: t("compactionLoading"),
      compactionDone: t("compactionDone"),

      updateBannerTitle: t("update.bannerTitle"),
      updateBannerBody: (current: string, latest: string, paseo: string) =>
        t("update.bannerBody", { current, latest, paseo }),
      updateBannerDismiss: t("update.bannerDismiss"),
    }),
    [t],
  );
}

/** 当前 App locale（如 zh-CN / en）。 */
export function useLocale(): string {
  return useTranslation(messages).locale;
}

/** 把服务端返回的中文提示翻译为英文（仅覆盖常见几条，其他保留原文）。 */
export function localizeServerMessage(messageText: string, locale: string): string {
  if (locale.toLowerCase().startsWith("zh")) return messageText;
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
