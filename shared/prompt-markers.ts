/** Internal prompt-wrapper markers shared by the daemon-side prompt builder and client renderer. */
export const PROMPT_MARKERS = {
  mainSnapshot: "以下为主会话的最近上下文快照",
  mainIncrement: "以下为主会话的新进展",
  previousThreadSummary: "以下为前一条侧聊线程的历史摘要",
  rebuiltThreadSummary: "以下为该侧聊线程被重建前的历史摘要",
  continuationPrefix: "这是一条接续的侧聊线程",
  continuationQuestion: "然后处理：",
  rebuildPrefix: "这是一条被重建的侧聊线程",
  rebuildQuestion: "然后继续处理：",
  emptyRebuildSummary: "（请简短总结此前的结论，然后等待用户的下一个问题。）",
  emptyRebuildWait: "（请等待用户的下一个问题。）",
} as const;
