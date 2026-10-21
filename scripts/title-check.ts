/** 实测：创建线程后 AI 标题是否自动生成（完成后自动清理）。 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPaseoClient } from "@getpaseo/client";
import { sidekickSettings } from "../shared/settings";
import { askThread, removeThread } from "../server/threads";
import { getThread } from "../server/registry";

async function main(): Promise<void> {
  const credential =
    (process.env.PASEO_PASSWORD ?? "").trim() ||
    readFileSync(join(homedir(), ".paseo", "local-credential"), "utf8").trim();
  const client = createPaseoClient({
    url: "ws://127.0.0.1:6767/ws",
    password: credential,
    clientId: "bytheway-title-check",
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
  if (!main) throw new Error("找不到可用作主会话的 agent");

  const settings = sidekickSettings.schema.parse({ attachToMain: false, snapshotDepth: 6 });
  const result = await askThread(client, settings, {
    mainAgentId: main.id,
    question: "帮我评估一下把侧聊线程的标题改成 AI 自动生成的方案有什么利弊？",
    mode: "ask",
    target: { kind: "new" },
    sendBehavior: "auto",
  });
  const initial = getThread(result.threadId)?.title ?? "";
  console.log("thread:", result.threadId);
  console.log("initial title:", initial);

  let title = initial;
  const started = Date.now();
  while (Date.now() - started < 75_000) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const current = getThread(result.threadId)?.title ?? "";
    if (current !== title) {
      title = current;
      break;
    }
  }
  console.log("final title:", title);
  console.log(title !== initial && !title.startsWith("[侧聊]") ? "TITLE OK" : "TITLE UNCHANGED");

  await removeThread(client, result.threadId);
  console.log("cleaned");
  await client.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
