/**
 * 命令创建/继续线程后，通知 ByTheWay 面板刷新并选中该线程。
 * 命令 handler 与面板组件运行在同一个 client runtime，用模块级信号直接通信
 * （openPanel API 不支持传参，且面板已打开时 openPanel 不会触发面板刷新）。
 */

export interface ThreadFocusRequest {
  mainAgentId: string;
  threadId: string;
}

/** 每个主会话只保留最新一条请求；避免一个面板的请求覆盖另一个主会话。 */
const MAX_PENDING_AGENTS = 16;
const pendingByAgent = new Map<string, string>();
const listeners = new Set<(request: ThreadFocusRequest) => void>();

function rememberPending(request: ThreadFocusRequest): void {
  const { mainAgentId, threadId } = request;
  // 重新插入以刷新 LRU 顺序。
  pendingByAgent.delete(mainAgentId);
  pendingByAgent.set(mainAgentId, threadId);
  while (pendingByAgent.size > MAX_PENDING_AGENTS) {
    const oldest = pendingByAgent.keys().next().value;
    if (oldest === undefined) break;
    pendingByAgent.delete(oldest);
  }
}

/** 命令侧调用：请求面板选中该线程；面板未挂载时按主会话暂存待消费。 */
export function requestThreadFocus(request: ThreadFocusRequest): void {
  rememberPending(request);
  for (const listener of listeners) listener(request);
}

/** 查看暂存请求但不消费；面板应用成功后再确认清除。 */
export function peekPendingThreadFocus(mainAgentId: string): string | null {
  return pendingByAgent.get(mainAgentId) ?? null;
}

/** 面板消费暂存请求；只认领属于自己 mainAgentId 的请求。 */
export function takePendingThreadFocus(
  mainAgentId: string,
  expectedThreadId?: string,
): string | null {
  const threadId = pendingByAgent.get(mainAgentId);
  if (threadId === undefined) return null;
  if (expectedThreadId !== undefined && threadId !== expectedThreadId) return null;
  pendingByAgent.delete(mainAgentId);
  return threadId;
}

/** 订阅后续请求（面板已打开场景）。 */
export function onThreadFocusRequest(listener: (request: ThreadFocusRequest) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
