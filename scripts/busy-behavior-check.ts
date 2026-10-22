/**
 * 运行中发送检查（直连本地 daemon）。
 *
 * 覆盖：侧聊正在回答时发送消息
 *   - 不再抛「侧聊正在回答中」
 *   - 行为为 interrupt：当前回合被打断（进行中的工具被取消），新消息作为新一轮发出
 *
 * 注意：本脚本与 daemon 内插件进程各自持有注册表内存副本；
 * 跑完后建议执行 `paseo plugin reload paseo-bytheway` 让 daemon 侧重读注册表。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPaseoClient } from "@getpaseo/client";
import { sidekickSettings } from "../shared/settings";
import { askThread, removeThread } from "../server/threads";

type Client = ReturnType<typeof createPaseoClient>;
type AgentHandle = ReturnType<Client["agents"]["ref"]>;

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

/** 工具调用状态（interrupt 应把进行中的工具标记为 canceled）。 */
async function toolStatuses(handle: AgentHandle): Promise<string[]> {
  const page = await handle.timeline.refetch({ direction: "tail", limit: 40 });
  return page.entries
    .filter((entry) => (entry.item as { type: string }).type === "tool_call")
    .map((entry) => {
      const item = entry.item as { name?: string; status?: string };
      return `${item.name ?? "?"}:${item.status ?? "?"}`;
    });
}

/** 等待出现一个进行中的工具调用（bash sleep），保证有稳定的「运行中」窗口。 */
async function waitToolRunning(handle: AgentHandle, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if ((await toolStatuses(handle)).some((entry) => entry.endsWith(":running"))) return;
    await sleep(1000);
  }
  throw new Error("未观察到进行中的工具调用");
}

async function main(): Promise<void> {
  const credential =
    (process.env.PASEO_PASSWORD ?? "").trim() ||
    readFileSync(join(homedir(), ".paseo", "local-credential"), "utf8").trim();
  const client = createPaseoClient({
    url: "ws://127.0.0.1:6767/ws",
    password: credential,
    clientId: "bytheway-busy-behavior-check",
    reconnect: { enabled: false },
  });
  await client.connect();
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
    console.log(`[1] running, tools=${(await toolStatuses(handle)).join(",")}`);

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

    // 上一回合的工具应被取消
    let tools: string[] = [];
    const started = Date.now();
    while (Date.now() - started < 20_000) {
      tools = await toolStatuses(handle);
      if (tools.some((entry) => entry.endsWith(":canceled"))) break;
      await sleep(1000);
    }
    console.log(`[4] tools=${tools.join(",")}`);
    if (tools.some((entry) => entry.endsWith(":running"))) {
      throw new Error(`打断后仍有工具在运行：${tools.join(",")}`);
    }
    if (!tools.some((entry) => entry.endsWith(":failed") || entry.endsWith(":canceled"))) {
      throw new Error(`打断后工具未被中止：${tools.join(",")}`);
    }

    console.log("BUSY-BEHAVIOR OK");
  } finally {
    await removeThread(client, first.threadId);
    console.log("cleaned");
    await client.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
