/** 实测：侧聊 thinking 默认继承 + 同一 subagent 原地切换思考档。 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPaseoClient } from "@getpaseo/client";
import { sidekickSettings } from "../shared/settings";
import { askThread, removeThread } from "../server/threads";
import { getThread } from "../server/registry";

type Client = ReturnType<typeof createPaseoClient>;
type AgentHandle = ReturnType<Client["agents"]["ref"]>;
type Model = NonNullable<Awaited<ReturnType<Client["providers"]["listModels"]>>["models"]>[number];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
    await sleep(1500);
  }
  throw new Error("timeout waiting for answer");
}

async function main(): Promise<void> {
  const credential =
    (process.env.PASEO_PASSWORD ?? "").trim() ||
    readFileSync(join(homedir(), ".paseo", "local-credential"), "utf8").trim();
  const client = createPaseoClient({
    url: "ws://127.0.0.1:6767/ws",
    password: credential,
    clientId: "bytheway-thinking-switch-check",
    reconnect: { enabled: false },
  });
  await client.connect();
  let threadId: string | null = null;

  try {
    const listing = await client.agents.list({});
    const candidates = listing.entries.filter(
      (entry: {
        agent: {
          workspaceId?: string;
          archivedAt?: string | null;
          status: string;
          labels?: Record<string, string>;
        };
      }) =>
        entry.agent.workspaceId &&
        !entry.agent.archivedAt &&
        ["idle", "running"].includes(entry.agent.status),
    );
    let main: (typeof candidates)[number]["agent"] | undefined;
    let candidateMainModel: Model | undefined;
    for (const entry of candidates.slice(0, 20)) {
      const mainModels = await client.providers.listModels(entry.agent.provider);
      const candidate = (mainModels.models ?? []).find(
        (value) =>
          value.id === entry.agent.model &&
          value.isSelectable !== false &&
          (value.thinkingOptions?.length ?? 0) >= 2,
      );
      if (candidate) {
        main = entry.agent;
        candidateMainModel = candidate;
        if (entry.agent.cwd === process.cwd()) break;
      }
    }
    main ??= (candidates.find((entry: { agent: { cwd?: string } }) => entry.agent.cwd === process.cwd()) ?? candidates[0])?.agent;
    if (!main) throw new Error("no active agent available as side-chat main");

    let modelSpec = `${main.provider}/${main.model}`;
    let model: Model | undefined;
    let followMain = false;
    if (candidateMainModel) {
      model = candidateMainModel;
      followMain = true;
    } else {
      const snapshot = await client.providers.snapshot();
      for (const entry of snapshot.entries ?? []) {
        if (entry.enabled === false || entry.status !== "ready") continue;
        const optionModel = (entry.models ?? []).find(
          (value) => value.isSelectable !== false && (value.thinkingOptions?.length ?? 0) >= 2,
        );
        if (optionModel) {
          modelSpec = `${entry.provider}/${optionModel.id}`;
          model = optionModel;
          break;
        }
      }
    }
    if (!model) throw new Error("no model exposes at least two thinking options");

    const options = model.thinkingOptions ?? [];
    const initialThinking = followMain
      ? main.effectiveThinkingOptionId ?? main.thinkingOptionId ?? model.defaultThinkingOptionId ?? null
      : options[0]?.id ?? null;
    const nextThinking = options.find((option) => option.id !== initialThinking) ?? options[1];
    if (!nextThinking) throw new Error("no alternate thinking option");

    const settings = sidekickSettings.schema.parse({ attachToMain: false, snapshotDepth: 6, aiTitles: false });
    const thread = await askThread(client, settings, {
      mainAgentId: main.id,
      question: "请只回复：thinking-a",
      mode: "ask",
      target: { kind: "new" },
      ...(!followMain ? { model: modelSpec, thinkingOptionId: initialThinking } : {}),
    });
    threadId = thread.threadId;
    const handle = client.agents.ref(thread.agentId);
    await waitAnswer(handle, 0, 180_000);

    const before = await handle.refresh();
    const beforeAgentId = before?.agent.id;
    const beforeThinking = before?.agent.thinkingOptionId ?? null;
    console.log(
      `[before] thread=${thread.threadId} agent=${beforeAgentId} model=${before?.agent.model} thinking=${beforeThinking} follow=${followMain} expected=${initialThinking}`,
    );
    if (beforeAgentId !== thread.agentId) throw new Error("subagent id changed before switch");
    if (beforeThinking !== initialThinking) {
      throw new Error(`initial thinking did not apply: expected ${initialThinking}, got ${beforeThinking}`);
    }

    const assistantBefore = await countAssistant(handle);
    const switched = await askThread(client, settings, {
      mainAgentId: main.id,
      question: "请只回复：thinking-b",
      mode: "ask",
      target: { kind: "continue", threadId: thread.threadId },
      thinkingOptionId: nextThinking.id,
    });
    if (switched.threadId !== thread.threadId || switched.agentId !== thread.agentId) {
      throw new Error("thinking switch replaced the thread or subagent");
    }

    const afterSwitch = await handle.refresh();
    const afterAgentId = afterSwitch?.agent.id;
    const afterThinking = afterSwitch?.agent.thinkingOptionId ?? null;
    const registryThinking = getThread(thread.threadId)?.thinkingOptionId ?? null;
    console.log(
      `[after-switch] thread=${switched.threadId} agent=${afterAgentId} model=${afterSwitch?.agent.model} thinking=${afterThinking} registry=${registryThinking}`,
    );
    if (afterAgentId !== beforeAgentId) throw new Error("subagent id changed during in-place thinking switch");
    if (afterThinking !== nextThinking.id) {
      throw new Error(`agent thinking not applied: expected ${nextThinking.id}, got ${afterThinking}`);
    }
    if (registryThinking !== nextThinking.id) throw new Error(`registry thinking not updated: ${registryThinking}`);

    await waitAnswer(handle, assistantBefore, 180_000);
    const afterAnswer = await handle.refresh();
    if (afterAnswer?.agent.id !== beforeAgentId) throw new Error("subagent id changed after answer");
    if ((afterAnswer?.agent.thinkingOptionId ?? null) !== nextThinking.id) {
      throw new Error("thinking option changed unexpectedly after answer");
    }

    console.log("THINKING-SWITCH OK");
  } finally {
    if (threadId) {
      await removeThread(client, threadId).catch(() => {});
      console.log("cleaned");
    }
    await client.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
