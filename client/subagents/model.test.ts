import { describe, expect, it } from "vitest";
import type { LiveItem } from "../live/types";
import {
  bucketForPaseoAgent,
  bucketForProviderStatus,
  countFinishedSubagents,
  isFinishedSubagent,
  mergeSubagentRows,
  providerRowsFromTimeline,
  summarizeSubagents,
  type PaseoSubagentAgentLike,
  type ProviderSubagentDescriptorLike,
} from "./model";

function paseoAgent(overrides: Partial<PaseoSubagentAgentLike> = {}): PaseoSubagentAgentLike {
  return {
    id: "child-1",
    title: "Research",
    provider: "opencode",
    model: "deepseek-v4.1-flash",
    status: "running",
    createdAt: "2026-10-27T01:00:00.000Z",
    updatedAt: "2026-10-27T01:00:05.000Z",
    ...overrides,
  };
}

function providerDescriptor(
  overrides: Partial<ProviderSubagentDescriptorLike> = {},
): ProviderSubagentDescriptorLike {
  return {
    id: "provider-1",
    parentAgentId: "parent-1",
    provider: "claude",
    title: "Explore",
    description: "Find the auth flow",
    status: "running",
    createdAt: "2026-10-27T01:00:00.000Z",
    updatedAt: "2026-10-27T01:00:05.000Z",
    toolCallId: "tool-1",
    ...overrides,
  };
}

function toolItem(overrides: Partial<Extract<LiveItem, { kind: "tool" }>> = {}): LiveItem {
  return {
    kind: "tool",
    key: "tool:tool-1",
    callId: "tool-1",
    name: "Task",
    status: "running",
    detail: {
      type: "sub_agent",
      subAgentType: "Explore",
      description: "Find the auth flow",
      childSessionId: "provider-1",
    },
    error: null,
    turnId: null,
    ...overrides,
  };
}

describe("subagent status mapping", () => {
  it("maps Paseo agent status and attention to the native-like bucket", () => {
    expect(bucketForPaseoAgent(paseoAgent())).toBe("running");
    expect(bucketForPaseoAgent(paseoAgent({ status: "initializing" }))).toBe("running");
    expect(bucketForPaseoAgent(paseoAgent({ status: "error" }))).toBe("failed");
    expect(bucketForPaseoAgent(paseoAgent({ status: "idle", requiresAttention: true }))).toBe("attention");
    expect(bucketForPaseoAgent(paseoAgent({ pendingPermissionCount: 1 }))).toBe("needs_input");
    expect(bucketForPaseoAgent(paseoAgent({ attentionReason: "permission" }))).toBe("needs_input");
    expect(bucketForPaseoAgent(paseoAgent({ status: "idle" }))).toBe("done");
  });

  it("maps provider statuses to running, failed, and done", () => {
    expect(bucketForProviderStatus("running")).toBe("running");
    expect(bucketForProviderStatus("failed")).toBe("failed");
    expect(bucketForProviderStatus("completed")).toBe("done");
    expect(bucketForProviderStatus("canceled")).toBe("done");
  });
});

describe("provider timeline seed", () => {
  it("uses childSessionId when present and falls back to the tool call id", () => {
    const rows = providerRowsFromTimeline(
      [
        toolItem(),
        toolItem({
          key: "tool:tool-2",
          callId: "tool-2",
          detail: {
            type: "sub_agent",
            subAgentType: "Reviewer",
            description: "Review the patch",
          },
        }),
      ],
      "parent-1",
      "claude",
      1_000,
    );
    expect(rows.map((row) => row.id)).toEqual(["provider-1", "tool-2"]);
    expect(rows[0]?.title).toBe("Find the auth flow");
    expect(rows[1]?.title).toBe("Review the patch");
  });
});

describe("mergeSubagentRows", () => {
  it("replaces a timeline seed when the live descriptor arrives", () => {
    const seed = providerRowsFromTimeline([toolItem()], "parent-1", "claude", 1_000);
    const rows = mergeSubagentRows({
      parentAgentId: "parent-1",
      paseoAgents: [],
      providerDescriptors: [providerDescriptor({ subtitle: "claude-sonnet" })],
      timelineRows: seed,
      now: 1_100,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.key).toBe("provider:provider-1");
    expect(rows[0]?.subtitle).toContain("claude-sonnet");
    expect(rows[0]?.toolCallId).toBe("tool-1");
  });

  it("merges Paseo children, filters hidden providers, and sorts by creation", () => {
    const rows = mergeSubagentRows({
      parentAgentId: "parent-1",
      paseoAgents: [paseoAgent()],
      providerDescriptors: [providerDescriptor({ createdAt: "2026-10-27T00:55:00.000Z" })],
      hiddenProviderIds: new Set(["provider-1"]),
      now: 1_100,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("paseo");
  });

  it("ignores provider descriptors that belong to another parent", () => {
    const rows = mergeSubagentRows({
      parentAgentId: "parent-1",
      paseoAgents: [],
      providerDescriptors: [
        providerDescriptor({ id: "other-parent", parentAgentId: "parent-2" }),
      ],
      now: 1_100,
    });
    expect(rows).toEqual([]);
  });
});

describe("finished subagents", () => {
  it("counts native-finished Paseo and provider rows", () => {
    const rows = mergeSubagentRows({
      parentAgentId: "parent-1",
      paseoAgents: [
        paseoAgent({ id: "idle", status: "idle" }),
        paseoAgent({ id: "running", status: "running" }),
      ],
      providerDescriptors: [
        providerDescriptor({ id: "completed", status: "completed" }),
        providerDescriptor({ id: "failed", status: "failed" }),
        providerDescriptor({ id: "running", status: "running" }),
      ],
      now: 1_100,
    });
    expect(countFinishedSubagents(rows)).toBe(3);
    expect(summarizeSubagents(rows)).toMatchObject({
      total: 5,
      running: 2,
      failed: 1,
    });
  });

  it("does not treat a subagent waiting for input as finished", () => {
    const rows = mergeSubagentRows({
      parentAgentId: "parent-1",
      paseoAgents: [paseoAgent({ status: "idle", pendingPermissionCount: 1 })],
      providerDescriptors: [],
      now: 1_100,
    });
    expect(rows[0]?.bucket).toBe("needs_input");
    expect(isFinishedSubagent(rows[0]!)).toBe(false);
    expect(countFinishedSubagents(rows)).toBe(0);
  });
});
