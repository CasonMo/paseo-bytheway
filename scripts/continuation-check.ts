/** 实测：接续线程（新开时通过 get_agent_activity 继承旧线程上下文）。 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPaseoClient } from "@getpaseo/client";
import { sidekickSettings } from "../shared/settings";
import { askThread, removeThread } from "../server/threads";

type Client = ReturnType<typeof createPaseoClient>;
type AgentHandle = ReturnType<Client["agents"]["ref"]>;

async function countAssistant(handle: AgentHandle): Promise<number> {
  const page = await handle.timeline.refetch({ direction: "tail", limit: 30 });
  return page.entries.filter((entry) => entry.item.type === "assistant_message").length;
}

async function waitAnswer(handle: AgentHandle, before: number, timeoutMs: number): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const snap = await handle.refresh();
    const status = snap?.agent?.status;
    const count = await countAssistant(handle);
    if (count > before && status !== "running") {
      const page = await handle.timeline.refetch({ direction: "tail", limit: 30 });
      const texts = page.entries
        .filter((entry) => entry.item.type === "assistant_message")
        .map((entry) => (entry.item as { text: string }).text);
      return texts[texts.length - 1] ?? "";
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error("timeout");
}

async function main(): Promise<void> {
  const credential =
    (process.env.PASEO_PASSWORD ?? "").trim() ||
    readFileSync(join(homedir(), ".paseo", "local-credential"), "utf8").trim();
  const client = createPaseoClient({
    url: "ws://127.0.0.1:6767/ws",
    password: credential,
    clientId: "bytheway-cont-check",
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
  const settings = sidekickSettings.schema.parse({ attachToMain: false, snapshotDepth: 6, aiTitles: false });

  const first = await askThread(client, settings, {
    mainAgentId: main.id,
    question: "请记住这个暗号：蓝色河马。只回复：已记住",
    mode: "ask",
    target: { kind: "new" },
  });
  const a1 = client.agents.ref(first.agentId);
  await waitAnswer(a1, 0, 120_000);
  console.log("[1] first thread answered");

  const second = await askThread(client, settings, {
    mainAgentId: main.id,
    question: "刚才的暗号是什么？只回答暗号本身。",
    mode: "ask",
    target: { kind: "new" },
    continuationOf: first.agentId,
  });
  console.log("[2] continuation agent:", second.agentId, "newThread:", second.agentId !== first.agentId);
  const a2 = client.agents.ref(second.agentId);
  const answer = await waitAnswer(a2, 0, 180_000);
  console.log("[2] answer:", answer.slice(0, 120).replace(/\n/g, " "));
  console.log(/河马/.test(answer) ? "CONTINUATION OK" : "CONTINUATION FAILED");

  await removeThread(client, first.threadId);
  await removeThread(client, second.threadId);
  console.log("cleaned");
  await client.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
