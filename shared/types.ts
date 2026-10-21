import type { ThreadMode, ThreadState, ThreadView } from "./contracts";

/** 线程注册表持久化记录（与 ThreadView 同构，另含内部字段）。 */
export interface ThreadRecord {
  id: string;
  mainAgentId: string;
  workspaceId: string;
  agentId: string;
  title: string;
  mode: ThreadMode;
  provider: string;
  model: string;
  thinkingOptionId: string | null;
  state: ThreadState;
  stateReason: string | null;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  /** 被动同步模式的游标：主会话已同步的单元数（消息+工具）与消息数。 */
  syncCursor: { unitsSeen: number; messagesSeen: number } | null;
}

export type { ThreadMode, ThreadState, ThreadView };

export function toThreadView(record: ThreadRecord): ThreadView {
  const { syncCursor: _syncCursor, ...view } = record;
  return view;
}
