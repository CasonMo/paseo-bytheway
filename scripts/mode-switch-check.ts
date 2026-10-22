import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPaseoClient } from "@getpaseo/client";
import { sidekickSettings } from "../shared/settings";
import { askThread, removeThread } from "../server/threads";
import { getThread } from "../server/registry";

type Client = ReturnType<typeof createPaseoClient>;
type AgentHandle = ReturnType<Client["agents"]["ref"]>;

async function countAssistant(handle: AgentHandle): Promise<number> {
  const page = await handle.timeline.refetch({ direction: "tail", limit: 30 });
  return page.entries.filter((entry) => entry.item.type === "assistant_message").length;
}

async function waitAnswer(handle: AgentHandle, before: number, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const snap = await handle.refresh();
    const count = await countAssistant(handle);
    if (count > before && snap?.agent?.status !== "running") return;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error("timeout");
}

async function lastUserMessage(handle: AgentHandle): Promise<string> {
  const page = await handle.timeline.refetch({ direction: "tail", limit: 20 });
  const texts = page.entries
    .filter((entry) => entry.item.type === "user_message")
    .map((entry) => (entry.item as { text: string }).text);
  return texts[texts.length - 1] ?? "";
}

async function main(): Promise<void> {
  const credential =
    (process.env.PASEO_PASSWORD ?? "").trim() ||
    readFileSync(join(homedir(), ".paseo", "local-credential"), "utf8").trim();
  const client = createPaseoClient({
    url: "ws://127.0.0.1:6767/ws",
    password: credential,
    clientId: "bytheway-mode-switch-check",
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
    question: "请只回复：a",
    mode: "ask",
    target: { kind: "new" },
  });
  const handle = client.agents.ref(first.agentId);
  await waitAnswer(handle, 0, 120_000);
  console.log("[1] ask thread answered");

  const switched = await askThread(client, settings, {
    mainAgentId: main.id,
    question: "请只回复：b",
    mode: "work",
    target: { kind: "continue", threadId: first.threadId },
  });
  const sameThread = switched.threadId === first.threadId && !switched.created;
  const registryMode = getThread(first.threadId)?.mode;
  const lastUser = await lastUserMessage(handle);
  const directive = lastUser.includes("模式切换");
  console.log(`[2] sameThread=${sameThread} registryMode=${registryMode} directive=${directive}`);
  await waitAnswer(handle, 1, 120_000);
  console.log("[2] answered after mode switch");
  console.log(sameThread && registryMode === "work" && directive ? "MODE-SWITCH OK" : "MODE-SWITCH FAILED");

  await removeThread(client, first.threadId);
  console.log("cleaned");
  await client.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
