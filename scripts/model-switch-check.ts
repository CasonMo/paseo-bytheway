/** 实测：已有线程原地切换模型（同 Provider）+ 跨 Provider 拒绝。 */
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
    if (count > before && snap?.agent.status !== "running") return;
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
    clientId: "bytheway-model-switch-check",
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

  const models = await client.providers.listModels("codex");
  const selectable = (models.models ?? []).filter((m) => m.isSelectable !== false);
  const modelA = selectable.find((m) => m.id === "deepseek-v4.1-flash") ?? selectable[0];
  const modelB = selectable.find((m) => m.id !== modelA?.id);
  if (!modelA || !modelB) throw new Error("codex models unavailable");

  const settings = sidekickSettings.schema.parse({ attachToMain: false, snapshotDepth: 6, aiTitles: false });
  const thread = await askThread(client, settings, {
    mainAgentId: main.id,
    question: "请只回复：a",
    mode: "ask",
    target: { kind: "new" },
    model: `codex/${modelA.id}`,
  });
  const handle = client.agents.ref(thread.agentId);
  await waitAnswer(handle, 0, 120_000);
  console.log(`[1] thread created with ${modelA.id}`);

  const switched = await askThread(client, settings, {
    mainAgentId: main.id,
    question: "请只回复：b",
    mode: "ask",
    target: { kind: "continue", threadId: thread.threadId },
    model: `codex/${modelB.id}`,
  });
  const sameThread = switched.threadId === thread.threadId && !switched.created;
  const snap = await handle.refresh();
  const registryModel = getThread(thread.threadId)?.model;
  console.log(`[2] sameThread=${sameThread} registry=${registryModel} agent=${snap?.agent.model}`);
  await waitAnswer(handle, 1, 180_000);
  console.log("[2] answered after in-place switch");
  const okSwitch = sameThread && registryModel === modelB.id && snap?.agent.model === modelB.id;

  let rejected = "";
  try {
    await askThread(client, settings, {
      mainAgentId: main.id,
      question: "不应发出",
      mode: "ask",
      target: { kind: "continue", threadId: thread.threadId },
      model: "claude/claude-opus-5",
    });
  } catch (error) {
    rejected = error instanceof Error ? error.message : String(error);
  }
  const okReject = rejected.includes("不能切换 provider");
  console.log(`[3] cross-provider rejected=${okReject} (${rejected.slice(0, 60)})`);

  console.log(okSwitch && okReject ? "MODEL-SWITCH OK" : "MODEL-SWITCH FAILED");
  await removeThread(client, thread.threadId);
  console.log("cleaned");
  await client.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
