import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPaseoClient } from "@getpaseo/client";
import { sidekickSettings } from "../shared/settings";
import { askThread, removeThread } from "../server/threads";

type Client = ReturnType<typeof createPaseoClient>;
type AgentHandle = ReturnType<Client["agents"]["ref"]>;

async function waitAnswer(handle: AgentHandle, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const snap = await handle.refresh();
    if (snap?.agent.status !== "running" && snap?.agent.status !== "initializing") {
      const page = await handle.timeline.refetch({ direction: "tail", limit: 10 });
      if (page.entries.some((entry) => entry.item.type === "assistant_message")) return;
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
    clientId: "bytheway-cross-provider-check",
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
  console.log("main provider:", main.provider);

  const available = await client.providers.listAvailable();
  const others = (available.providers ?? []).filter((p) => p.available && p.provider !== main.provider);
  const target = others.find((p) => p.provider === "opencode") ?? others[0];
  if (!target) throw new Error("no other provider available");
  const models = await client.providers.listModels(target.provider);
  const model = (models.models ?? []).find((m) => m.isSelectable !== false);
  if (!model) throw new Error("no model on " + target.provider);
  console.log(`cross target: ${target.provider}/${model.id}`);

  const settings = sidekickSettings.schema.parse({ attachToMain: false, snapshotDepth: 6, aiTitles: false });
  const thread = await askThread(client, settings, {
    mainAgentId: main.id,
    question: "请只回复：ok",
    mode: "ask",
    target: { kind: "new" },
    model: `${target.provider}/${model.id}`,
  });
  const handle = client.agents.ref(thread.agentId);
  const snap = await handle.refresh();
  console.log(`agent provider=${snap?.agent.provider} model=${snap?.agent.model}`);
  await waitAnswer(handle, 150_000);
  console.log("answered");
  const ok = snap?.agent.provider === target.provider && snap?.agent.model === model.id;
  console.log(ok ? "CROSS-PROVIDER OK" : "CROSS-PROVIDER FAILED");
  await removeThread(client, thread.threadId);
  console.log("cleaned");
  await client.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
