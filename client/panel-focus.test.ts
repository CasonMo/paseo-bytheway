import { describe, expect, it } from "vitest";
import {
  onThreadFocusRequest,
  peekPendingThreadFocus,
  requestThreadFocus,
  takePendingThreadFocus,
} from "./panel-focus";

describe("thread focus requests", () => {
  it("keeps pending requests separate per main agent", () => {
    requestThreadFocus({ mainAgentId: "agent-a-test", threadId: "thread-a-1" });
    requestThreadFocus({ mainAgentId: "agent-b-test", threadId: "thread-b-1" });

    expect(takePendingThreadFocus("agent-a-test")).toBe("thread-a-1");
    expect(takePendingThreadFocus("agent-b-test")).toBe("thread-b-1");
  });

  it("keeps only the latest thread for one main agent", () => {
    requestThreadFocus({ mainAgentId: "agent-latest-test", threadId: "thread-old" });
    requestThreadFocus({ mainAgentId: "agent-latest-test", threadId: "thread-new" });

    expect(takePendingThreadFocus("agent-latest-test")).toBe("thread-new");
    expect(takePendingThreadFocus("agent-latest-test")).toBeNull();
  });

  it("does not consume another agent's pending request", () => {
    requestThreadFocus({ mainAgentId: "agent-owner-test", threadId: "thread-owner" });

    expect(takePendingThreadFocus("agent-other-test")).toBeNull();
    expect(takePendingThreadFocus("agent-owner-test")).toBe("thread-owner");
  });

  it("notifies an open panel and lets it consume the queued request", () => {
    const seen: string[] = [];
    const unsubscribe = onThreadFocusRequest((request) => {
      seen.push(request.threadId);
      takePendingThreadFocus(request.mainAgentId);
    });

    requestThreadFocus({ mainAgentId: "agent-open-test", threadId: "thread-open" });
    unsubscribe();

    expect(seen).toEqual(["thread-open"]);
    expect(takePendingThreadFocus("agent-open-test")).toBeNull();
  });
});

describe("thread focus request acknowledgement", () => {
  it("does not clear a newer request when acknowledging an older one", () => {
    requestThreadFocus({ mainAgentId: "agent-ack-test", threadId: "thread-old" });
    requestThreadFocus({ mainAgentId: "agent-ack-test", threadId: "thread-new" });

    expect(takePendingThreadFocus("agent-ack-test", "thread-old")).toBeNull();
    expect(takePendingThreadFocus("agent-ack-test", "thread-new")).toBe("thread-new");
  });
});

describe("thread focus peek", () => {
  it("does not consume the pending request until acknowledged", () => {
    requestThreadFocus({ mainAgentId: "agent-peek-test", threadId: "thread-peek" });

    expect(peekPendingThreadFocus("agent-peek-test")).toBe("thread-peek");
    expect(peekPendingThreadFocus("agent-peek-test")).toBe("thread-peek");
    expect(takePendingThreadFocus("agent-peek-test", "thread-peek")).toBe("thread-peek");
    expect(peekPendingThreadFocus("agent-peek-test")).toBeNull();
  });
});
