/** 实测：线程标题/置顶/游标写入 agent metadata，并可从 agent 侧恢复。 */
import { sidekickSettings } from "../shared/settings";
import {
  askThread,
  pinThread,
  recoverThreadsFromAgents,
  removeThread,
  renameThread,
} from "../server/threads";
import { getThread } from "../server/registry";
import { connectLocalClient } from "./local-client";

async function main(): Promise<void> {
  const { daemon, client } = await connectLocalClient("bytheway-metadata-check");
  const listing = await client.agents.list({});
  const main = listing.entries.find(
    (entry) =>
      entry.agent.workspaceId &&
      !entry.agent.archivedAt &&
      ["idle", "running"].includes(entry.agent.status),
  )?.agent;
  if (!main) throw new Error("no main agent");

  const settings = sidekickSettings.schema.parse({
    attachToMain: false,
    snapshotDepth: 0,
    aiTitles: false,
  });
  let threadId: string | null = null;
  try {
    const thread = await askThread(client, settings, {
      mainAgentId: main.id,
      question: "metadata check",
      mode: "ask",
      target: { kind: "new" },
    });
    threadId = thread.threadId;

    await renameThread(client, thread.threadId, "Metadata 标题");
    await pinThread(client, thread.threadId, true);
    const snapshot = await client.agents.ref(thread.agentId).refresh();
    const metadata = snapshot?.agent.metadata ?? {};
    if (metadata["bytheway.threadId"] !== thread.threadId) {
      throw new Error("threadId metadata missing");
    }
    if (metadata["bytheway.mainAgentId"] !== main.id) {
      throw new Error("mainAgentId metadata missing");
    }
    if (metadata["bytheway.title"] !== "Metadata 标题") {
      throw new Error(`title metadata mismatch: ${String(metadata["bytheway.title"])}`);
    }
    if (metadata["bytheway.pinned"] !== true) {
      throw new Error("pinned metadata mismatch");
    }

    await recoverThreadsFromAgents(client);
    const recovered = getThread(thread.threadId);
    if (!recovered || recovered.title !== "Metadata 标题" || !recovered.pinned) {
      throw new Error("recovery from metadata failed");
    }
    console.log("METADATA OK");
  } finally {
    if (threadId) await removeThread(client, threadId);
    await daemon.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
