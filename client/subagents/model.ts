import type { LiveItem, ToolItem } from "../live/types";

export const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";

export type SubagentKind = "paseo" | "provider";

export type SubagentBucket =
  | "running"
  | "failed"
  | "needs_input"
  | "attention"
  | "done";

export interface PaseoSubagentAgentLike {
  id: string;
  title: string | null;
  provider: string;
  model: string | null;
  status: "initializing" | "idle" | "running" | "error" | "closed";
  pendingPermissionCount?: number;
  requiresAttention?: boolean;
  attentionReason?: "finished" | "error" | "permission" | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderSubagentDescriptorLike {
  id: string;
  parentAgentId: string;
  provider: string;
  title: string | null;
  description: string | null;
  status: "running" | "completed" | "failed" | "canceled";
  createdAt: string;
  updatedAt: string;
  toolCallId?: string | null;
  subtitle?: string | null;
}

export interface SubagentRow {
  key: string;
  kind: SubagentKind;
  id: string;
  parentAgentId: string;
  title: string;
  subtitle: string | null;
  provider: string | null;
  model: string | null;
  bucket: SubagentBucket;
  rawStatus: string;
  createdAt: number;
  updatedAt: number;
  toolCallId: string | null;
}

export interface SubagentSummary {
  total: number;
  running: number;
  failed: number;
  needsInput: number;
  attention: number;
  done: number;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseTimestamp(value: string | null | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function uniqueParts(parts: Array<string | null>): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    const key = part.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(part);
  }
  return output;
}

export function bucketForPaseoAgent(agent: PaseoSubagentAgentLike): SubagentBucket {
  if ((agent.pendingPermissionCount ?? 0) > 0 || agent.attentionReason === "permission") {
    return "needs_input";
  }
  if (agent.status === "error" || agent.attentionReason === "error") return "failed";
  if (agent.status === "running" || agent.status === "initializing") return "running";
  if (agent.requiresAttention) return "attention";
  return "done";
}

export function bucketForProviderStatus(
  status: ProviderSubagentDescriptorLike["status"] | ToolItem["status"],
): SubagentBucket {
  switch (status) {
    case "running":
      return "running";
    case "failed":
      return "failed";
    default:
      return "done";
  }
}

export function paseoSubagentRow(
  agent: PaseoSubagentAgentLike,
  parentAgentId: string,
  now = Date.now(),
): SubagentRow {
  const title = readNonEmptyString(agent.title) ?? "Subagent";
  const subtitle = uniqueParts([
    readNonEmptyString(agent.model),
    readNonEmptyString(agent.provider),
  ]).join(" · ");
  return {
    key: `paseo:${agent.id}`,
    kind: "paseo",
    id: agent.id,
    parentAgentId,
    title,
    subtitle: subtitle || null,
    provider: agent.provider,
    model: agent.model,
    bucket: bucketForPaseoAgent(agent),
    rawStatus: agent.status,
    createdAt: parseTimestamp(agent.createdAt, now),
    updatedAt: parseTimestamp(agent.updatedAt, now),
    toolCallId: null,
  };
}

export function providerSubagentRow(descriptor: ProviderSubagentDescriptorLike): SubagentRow {
  const title = readNonEmptyString(descriptor.description)
    ?? readNonEmptyString(descriptor.title)
    ?? "Subagent";
  const type = readNonEmptyString(descriptor.title);
  const subtitle = uniqueParts([
    readNonEmptyString(descriptor.subtitle),
    type && type !== title ? type : null,
    readNonEmptyString(descriptor.provider),
  ]).join(" · ");
  return {
    key: `provider:${descriptor.id}`,
    kind: "provider",
    id: descriptor.id,
    parentAgentId: descriptor.parentAgentId,
    title,
    subtitle: subtitle || null,
    provider: descriptor.provider,
    model: null,
    bucket: bucketForProviderStatus(descriptor.status),
    rawStatus: descriptor.status,
    createdAt: parseTimestamp(descriptor.createdAt, Date.now()),
    updatedAt: parseTimestamp(descriptor.updatedAt, Date.now()),
    toolCallId: descriptor.toolCallId ?? null,
  };
}

export function providerRowsFromTimeline(
  items: LiveItem[],
  parentAgentId: string,
  fallbackProvider: string | null,
  now = Date.now(),
): SubagentRow[] {
  const rows = new Map<string, SubagentRow>();
  let index = 0;
  for (const item of items) {
    if (item.kind !== "tool") continue;
    const detail = item.detail;
    if (!detail || detail.type !== "sub_agent") continue;
    const id = readNonEmptyString(detail.childSessionId) ?? item.callId;
    const title = readNonEmptyString(detail.subAgentType) ?? item.name ?? "Subagent";
    const description = readNonEmptyString(detail.description);
    const displayTitle = description ?? title;
    const subtitle = uniqueParts([
      title !== displayTitle ? title : null,
      fallbackProvider,
    ]).join(" · ");
    rows.set(id, {
      key: `provider:${id}`,
      kind: "provider",
      id,
      parentAgentId,
      title: displayTitle,
      subtitle: subtitle || null,
      provider: fallbackProvider,
      model: null,
      bucket: bucketForProviderStatus(item.status),
      rawStatus: item.status,
      createdAt: now + index,
      updatedAt: now + index,
      toolCallId: item.callId,
    });
    index += 1;
  }
  return [...rows.values()];
}

export function mergeSubagentRows(input: {
  parentAgentId: string;
  paseoAgents: PaseoSubagentAgentLike[];
  providerDescriptors: ProviderSubagentDescriptorLike[];
  timelineRows?: SubagentRow[];
  hiddenProviderIds?: ReadonlySet<string>;
  now?: number;
}): SubagentRow[] {
  const now = input.now ?? Date.now();
  const hidden = input.hiddenProviderIds ?? new Set<string>();
  const rows = new Map<string, SubagentRow>();
  const toolCallToKey = new Map<string, string>();
  const timelineKeys = new Set<string>();

  for (const row of input.timelineRows ?? []) {
    rows.set(row.key, row);
    timelineKeys.add(row.key);
    if (row.toolCallId) toolCallToKey.set(row.toolCallId, row.key);
  }

  for (const descriptor of input.providerDescriptors) {
    if (descriptor.parentAgentId !== input.parentAgentId) continue;
    const key = `provider:${descriptor.id}`;
    if (descriptor.toolCallId) {
      const seedKey = toolCallToKey.get(descriptor.toolCallId);
      if (seedKey && seedKey !== key && timelineKeys.has(seedKey)) rows.delete(seedKey);
      toolCallToKey.set(descriptor.toolCallId, key);
    }
    rows.set(key, providerSubagentRow(descriptor));
  }

  for (const agent of input.paseoAgents) {
    const row = paseoSubagentRow(agent, input.parentAgentId, now);
    rows.set(row.key, row);
  }

  return [...rows.values()]
    .filter((row) => row.kind !== "provider" || !hidden.has(row.id))
    .sort((left, right) => left.createdAt - right.createdAt || left.title.localeCompare(right.title));
}

export function summarizeSubagents(rows: SubagentRow[]): SubagentSummary {
  const summary: SubagentSummary = {
    total: rows.length,
    running: 0,
    failed: 0,
    needsInput: 0,
    attention: 0,
    done: 0,
  };
  for (const row of rows) {
    switch (row.bucket) {
      case "running":
        summary.running += 1;
        break;
      case "failed":
        summary.failed += 1;
        break;
      case "needs_input":
        summary.needsInput += 1;
        break;
      case "attention":
        summary.attention += 1;
        break;
      default:
        summary.done += 1;
    }
  }
  return summary;
}

export function isFinishedSubagent(row: SubagentRow): boolean {
  if (row.kind === "paseo") {
    if (row.bucket === "running" || row.bucket === "needs_input") return false;
    return row.rawStatus === "idle" || row.rawStatus === "error";
  }
  return row.rawStatus === "completed"
    || row.rawStatus === "failed"
    || row.rawStatus === "canceled";
}

export function countFinishedSubagents(rows: SubagentRow[]): number {
  return rows.reduce((count, row) => count + (isFinishedSubagent(row) ? 1 : 0), 0);
}
