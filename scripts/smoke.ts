/**
 * Sidekick 端到端 smoke（直连本地 daemon）。
 *
 * 覆盖：新开线程 → 首轮回答 → 续聊 → 归档 → stopped 校验 → 重建 → 清理。
 * 注意：本脚本与 daemon 内插件进程各自持有注册表内存副本；
 * 跑完后建议执行 `paseo plugin reload paseo-bytheway` 让 daemon 侧重读注册表。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPaseoClient } from "@getpaseo/client";
import { sidekickSettings } from "../shared/settings";
import { askThread, archiveThread, rebuildThread, removeThread } from "../server/threads";

type Client = ReturnType<typeof createPaseoClient>;
type AgentHandle = ReturnType<Client["agents"]["ref"]>;

const CREDENTIAL = join(homedir(), ".paseo", "local-credential");
const URL = process.env.SIDEKICK_SMOKE_URL ?? "ws://127.0.0.1:6767/ws";

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function countAssistant(handle: AgentHandle): Promise<number> {
  const page = await handle.timeline.refetch({ direction: "tail", limit: 30 });
  return page.entries.filter((entry: any) => entry.item.type === "assistant_message").length;
}

async function waitNewAnswer(handle: AgentHandle, beforeCount: number, timeoutMs: number): Promise<string> {
  const started = Date.now();
  let sawRunning = false;
  while (Date.now() - started < timeoutMs) {
    const snap = await handle.refresh();
    const status = snap?.agent?.status;
    if (status === "running") sawRunning = true;
    const count = await countAssistant(handle);
    if (count > beforeCount && status !== "running") {
      const page = await handle.timeline.refetch({ direction: "tail", limit: 30 });
      const texts = page.entries
        .filter((entry: any) => entry.item.type === "assistant_message")
        .map((entry: any) => entry.item.text);
      return texts[texts.length - 1] ?? "";
    }
    if (!snap) fail(`agent ${handle.id} 在等待回答时消失（sawRunning=${sawRunning}）`);
    await sleep(1500);
  }
  fail(`等待回答超时（${timeoutMs}ms）`);
}

async function main(): Promise<void> {
  const credential =
    (process.env.PASEO_PASSWORD ?? "").trim() ||
    (() => {
      try {
        return readFileSync(CREDENTIAL, "utf8").trim();
      } catch {
        return fail("缺少凭据：请设置 PASEO_PASSWORD（~/.zshenv）");
      }
    })();
  const client = createPaseoClient({
    url: URL,
    password: credential,
    clientId: "bytheway-smoke",
    reconnect: { enabled: false },
  });
  await client.connect();
  console.log("connected");

  const listing = await client.agents.list({});
  const candidates = listing.entries.filter(
    (entry: any) =>
      entry.agent.workspaceId &&
      !entry.agent.archivedAt &&
      (entry.agent.status === "idle" || entry.agent.status === "running"),
  );
  const preferred = candidates.find((entry: any) => entry.agent.cwd === process.cwd());
  const main = (preferred ?? candidates[0])?.agent;
  if (!main) fail("找不到可用作主会话的 agent");
  console.log(`main agent: ${main.id} (${main.provider}/${main.model})`);

  const settings = sidekickSettings.schema.parse({ attachToMain: false, snapshotDepth: 6, defaultModel: "follow", aiTitles: false });
  let threadId: string | null = null;

  try {
    // 1. 新开线程
    const first = await askThread(client, settings, {
      mainAgentId: main.id,
      question: "请只回复这五个字符：smoke1",
      mode: "ask",
      target: { kind: "new" },
    });
    threadId = first.threadId;
    console.log(`[1] created thread ${first.threadId} agent ${first.agentId} created=${first.created}`);
    if (!first.created) fail("新开线程应返回 created=true");

    const agent1 = client.agents.ref(first.agentId);
    const snap1 = await agent1.refresh();
    const labels = snap1?.agent?.labels ?? {};
    if (labels.sidekick !== "1" || labels["sidekick.thread"] !== first.threadId) {
      fail(`labels 不正确: ${JSON.stringify(labels)}`);
    }
    console.log(`[1] labels ok: ${JSON.stringify(labels)}`);

    const answer1 = await waitNewAnswer(agent1, 0, 180_000);
    if (!/smoke1/.test(answer1)) fail(`首轮回答异常: ${answer1.slice(0, 200)}`);
    console.log(`[1] answer ok: ${answer1.slice(0, 80).replace(/\n/g, " ")}`);

    // 2. 续聊（复用）
    const before2 = await countAssistant(agent1);
    const second = await askThread(client, settings, {
      mainAgentId: main.id,
      question: "请只回复这五个字符：smoke2",
      mode: "ask",
      target: { kind: "continue" },
    });
    if (second.created) fail("续聊应返回 created=false");
    if (second.threadId !== first.threadId) fail("续聊应复用同一线程");
    const answer2 = await waitNewAnswer(agent1, before2, 180_000);
    if (!/smoke2/.test(answer2)) fail(`续聊回答异常: ${answer2.slice(0, 200)}`);
    console.log(`[2] continue ok: ${answer2.slice(0, 80).replace(/\n/g, " ")}`);

    // 3. 归档 → stopped 校验
    await archiveThread(client, first.threadId);
    console.log("[3] archived");
    let stoppedError = "";
    try {
      await askThread(client, settings, {
        mainAgentId: main.id,
        question: "不应发出",
        mode: "ask",
        target: { kind: "continue", threadId: first.threadId },
      });
    } catch (error) {
      stoppedError = error instanceof Error ? error.message : String(error);
    }
    if (!/停止/.test(stoppedError)) fail(`stopped 线程应报错，实际: ${stoppedError}`);
    console.log(`[3] stopped thread error ok: ${stoppedError}`);

    // 4. 重建并继续
    const rebuilt = await rebuildThread(client, settings, first.threadId, "请只回复这五个字符：smoke3");
    if (rebuilt.threadId !== first.threadId) fail("重建应保留 threadId");
    const agent2 = client.agents.ref(rebuilt.agentId);
    const answer3 = await waitNewAnswer(agent2, 0, 180_000);
    if (!/smoke3/.test(answer3)) fail(`重建回答异常: ${answer3.slice(0, 200)}`);
    console.log(`[4] rebuild ok: ${answer3.slice(0, 80).replace(/\n/g, " ")}`);

    // 5. 清理
    await removeThread(client, first.threadId);
    console.log("[5] removed");
    console.log("SMOKE OK");
  } finally {
    if (threadId) {
      try {
        await removeThread(client, threadId);
      } catch {
        // best effort
      }
    }
    await client.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
