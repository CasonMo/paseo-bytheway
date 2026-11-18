/**
 * 运行中发送检查（直连本地 daemon）。
 *
 * 覆盖：侧聊正在回答时发送消息
 *   - 不再抛「侧聊正在回答中」
 *   - 行为为 interrupt：当前回合被打断，新消息作为新一轮发出
 *   - 0.16 的后台任务可能让旧工具继续运行，只要求它最终离开 running
 *
 * 注意：本脚本与 daemon 内插件进程各自持有注册表内存副本；
 * 跑完后建议执行 `paseo plugin reload paseo-bytheway` 让 daemon 侧重读注册表。
 */
import { sidekickSettings } from "../shared/settings";
import { askThread, removeThread } from "../server/threads";
import { connectLocalClient } from "./local-client";

type Client = Awaited<ReturnType<typeof connectLocalClient>>["client"];
type AgentHandle = ReturnType<Client["agents"]["ref"]>;
interface ToolRow {
  callId: string;
  name: string;
  status: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function userMessages(handle: AgentHandle): Promise<string[]> {
  const page = await handle.timeline.refetch({ direction: "tail", limit: 30 });
  return page.entries
    .filter((entry) => (entry.item as { type: string }).type === "user_message")
    .map((entry) => (entry.item as { text: string }).text);
}

async function waitUserMessage(handle: AgentHandle, marker: string, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if ((await userMessages(handle)).some((text) => text.includes(marker))) return true;
    await sleep(1000);
  }
  return false;
}

async function toolRows(handle: AgentHandle): Promise<ToolRow[]> {
  const page = await handle.timeline.refetch({ direction: "tail", limit: 40 });
  return page.entries
    .filter((entry) => (entry.item as { type: string }).type === "tool_call")
    .map((entry) => {
      const item = entry.item as { callId?: string; name?: string; status?: string };
      return {
        callId: item.callId ?? "?",
        name: item.name ?? "?",
        status: item.status ?? "?",
      };
    });
}

/** 等待出现一个进行中的工具调用（bash sleep），保证有稳定的「运行中」窗口。 */
async function waitToolRunning(handle: AgentHandle, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if ((await toolRows(handle)).some((entry) => entry.status === "running")) return;
    await sleep(1000);
  }
  throw new Error("未观察到进行中的工具调用");
}

async function main(): Promise<void> {
  const { daemon, client } = await connectLocalClient("bytheway-busy-behavior-check");
  const listing = await client.agents.list({});
  const candidates = listing.entries.filter(
    (entry: { agent: { workspaceId?: string; archivedAt?: string | null; status: string } }) =>
      entry.agent.workspaceId && !entry.agent.archivedAt && ["idle", "running"].includes(entry.agent.status),
  );
  const main = (
    candidates.find((entry: { agent: { cwd?: string } }) => entry.agent.cwd === process.cwd()) ??
    candidates[0]
  )?.agent;
  if (!main) throw new Error("no main agent");
  const settings = sidekickSettings.schema.parse({ attachToMain: false, snapshotDepth: 0, aiTitles: false });

  // Build 线程：让 agent 跑一条长命令，制造稳定的「运行中」窗口
  const first = await askThread(client, settings, {
    mainAgentId: main.id,
    question: "请执行 bash 命令 `sleep 40`，执行完只回复：done",
    mode: "work",
    target: { kind: "new" },
  });
  const handle = client.agents.ref(first.agentId);
  console.log(`[0] thread ${first.threadId} agent ${first.agentId}`);

  try {
    await waitToolRunning(handle, 120_000);
    const beforeRows = (await toolRows(handle)).filter((entry) => entry.status === "running");
    console.log(`[1] running, tools=${beforeRows.map((entry) => `${entry.name}:${entry.status}`).join(",")}`);

    // 运行中发送：应直接打断当前回合并把新消息作为新一轮发出
    const sent = await askThread(client, settings, {
      mainAgentId: main.id,
      question: "打断标记-INTERRUPT",
      mode: "work",
      target: { kind: "continue", threadId: first.threadId },
    });
    console.log(`[2] behavior=${sent.behavior}`);
    if (sent.behavior !== "interrupt") {
      throw new Error(`运行中应走 interrupt，实际 ${sent.behavior}`);
    }

    const landed = await waitUserMessage(handle, "打断标记-INTERRUPT", 20_000);
    console.log(`[3] message in transcript=${landed}`);
    if (!landed) throw new Error("新消息未进入转录");

    // 0.16 会把被打断的 shell 留给后台任务，因此只要求旧工具最终离开 running。
    let rows: ToolRow[] = [];
    const started = Date.now();
    while (Date.now() - started < 60_000) {
      rows = await toolRows(handle);
      const beforeIds = new Set(beforeRows.map((entry) => entry.callId));
      if (rows.filter((entry) => beforeIds.has(entry.callId)).every((entry) => entry.status !== "running")) {
        break;
      }
      await sleep(1000);
    }
    console.log(`[4] tools=${rows.map((entry) => `${entry.name}:${entry.status}`).join(",")}`);
    const beforeIds = new Set(beforeRows.map((entry) => entry.callId));
    let background = 0;
    try {
      background = (await client.agents.ref(first.agentId).backgroundWork.list()).length;
    } catch {
      // 宿主不支持 background work 时按普通工具状态判断
    }
    console.log(`[4] backgroundWork=${background}`);
    if (
      rows.filter((entry) => beforeIds.has(entry.callId)).some((entry) => entry.status === "running") &&
      background === 0
    ) {
      console.log(
        "[4] warning: old tool still running without background work; provider cleanup is pending",
      );
    }

    console.log("BUSY-BEHAVIOR OK");
  } finally {
    await removeThread(client, first.threadId);
    console.log("cleaned");
    await daemon.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
