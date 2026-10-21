import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  contextPreview,
  threadsArchive,
  threadsAsk,
  threadsCancel,
  threadsList,
  threadsPin,
  threadsRebuild,
  threadsRemove,
  threadsRename,
  threadsSendToMain,
} from "./shared/contracts";
import { sidekickSettings, type SidekickSettings } from "./shared/settings";
import { toThreadView } from "./shared/types";
import { registerPermissionAutoHandlers } from "./server/hooks";
import { ensureLoaded, flushSave, listThreads } from "./server/registry";
import {
  archiveThread,
  askThread,
  cancelThread,
  previewContext,
  rebuildThread,
  reapOrphans,
  refreshThreadStates,
  removeThread,
  renameThread,
  pinThread,
  sendToMain,
} from "./server/threads";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(sidekickSettings);

  const readSettings = async (): Promise<SidekickSettings> => {
    try {
      const state = await settings.read();
      if (state.status === "ready") return state.values;
    } catch {
      // fall through to defaults
    }
    return sidekickSettings.schema.parse({});
  };

  const disposePermissionHooks = registerPermissionAutoHandlers(server, readSettings);

  let reaped = false;
  const reapOnce = (paseo: Parameters<typeof reapOrphans>[0]) => {
    if (reaped) return;
    reaped = true;
    void reapOrphans(paseo);
  };

  server.handle(threadsList, async (input, { paseo }) => {
    await ensureLoaded();
    reapOnce(paseo);
    const threadStatuses = await refreshThreadStates(paseo, input.mainAgentId);
    try {
      const running = await paseo.agents.list({
        filter: { labels: { sidekick: "1" }, statuses: ["running"], includeArchived: false },
      });
      for (const entry of running.entries) {
        const threadId = entry.agent.labels?.["sidekick.thread"];
        if (typeof threadId === "string") threadStatuses[threadId] = "running";
      }
    } catch {
      // 列表失败时不影响返回
    }
    // 补齐未被逐线程刷新的条目
    for (const thread of listThreads(input.mainAgentId)) {
      if (!threadStatuses[thread.id]) {
        threadStatuses[thread.id] = thread.state === "open" ? "idle" : "closed";
      }
    }
    return {
      threads: listThreads(input.mainAgentId).map(toThreadView),
      threadStatuses,
    };
  });

  server.handle(threadsAsk, async (input, { paseo }) => {
    reapOnce(paseo);
    const values = await readSettings();
    return askThread(paseo, values, input);
  });

  server.handle(threadsArchive, async (input, { paseo }) => {
    await archiveThread(paseo, input.threadId);
    return { ok: true };
  });

  server.handle(threadsRemove, async (input, { paseo }) => {
    await removeThread(paseo, input.threadId);
    return { ok: true };
  });

  server.handle(threadsRename, async (input) => {
    await renameThread(input.threadId, input.title);
    return { ok: true };
  });

  server.handle(threadsPin, async (input) => {
    await pinThread(input.threadId, input.pinned);
    return { ok: true };
  });

  server.handle(threadsRebuild, async (input, { paseo }) => {
    const values = await readSettings();
    return rebuildThread(paseo, values, input.threadId, input.question, input.model);
  });

  server.handle(threadsCancel, async (input, { paseo }) => {
    return cancelThread(paseo, input.threadId);
  });

  server.handle(threadsSendToMain, async (input, { paseo }) => {
    return sendToMain(paseo, input.threadId, input.text, input.behavior);
  });

  server.handle(contextPreview, async (input, { paseo }) => {
    const values = await readSettings();
    return previewContext(paseo, values, {
      mainAgentId: input.mainAgentId,
      mode: input.mode,
      question: input.question,
    });
  });

  return () => {
    disposePermissionHooks();
    void flushSave().catch(() => {});
  };
}
