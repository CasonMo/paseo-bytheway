import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  contextPreview,
  modelConfigsList,
  threadsArchive,
  threadsAsk,
  threadsCancel,
  threadsList,
  threadsPin,
  threadsRebuild,
  threadsRemove,
  threadsRename,
  threadsSendToMain,
  threadsSummary,
  updateCheck,
  uploadsForMessage,
} from "./shared/contracts";
import { sidekickSettings, type SidekickSettings } from "./shared/settings";
import { toThreadView } from "./shared/types";
import type { EffectiveAgentConfig } from "./shared/model-configs";
import { registerPermissionAutoHandlers } from "./server/hooks";
import {
  ensureLoaded as ensureModelConfigsLoaded,
  flushSave as flushModelConfigsSave,
  listModelConfigs,
  rememberModelConfig as rememberModelConfigRecord,
} from "./server/model-configs";
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
import { checkUpdate } from "./server/update";
import { readMessageAttachments } from "./server/uploads";

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

  const rememberEffectiveConfig = async (
    values: SidekickSettings,
    config: EffectiveAgentConfig,
  ): Promise<void> => {
    if (!values.rememberModelConfig) return;
    await rememberModelConfigRecord(config.provider, config.model, {
      modeId: config.modeId,
      thinkingOptionId: config.thinkingOptionId,
      featureValues: config.featureValues,
    });
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

  server.handle(threadsSummary, async (_input, { paseo }) => {
    const workspaces: Record<
      string,
      { total: number; running: number; attention: number }
    > = {};
    try {
      const listing = await paseo.agents.list({
        filter: { labels: { sidekick: "1" }, includeArchived: false },
      });
      for (const entry of listing.entries) {
        const agent = entry.agent;
        const workspaceId = agent.workspaceId;
        if (!workspaceId) continue;
        const bucket = (workspaces[workspaceId] ??= { total: 0, running: 0, attention: 0 });
        bucket.total += 1;
        if (agent.status === "running") bucket.running += 1;
        if (agent.requiresAttention) bucket.attention += 1;
      }
    } catch {
      // 摘要失败时返回空表，不影响侧栏
    }
    return { workspaces };
  });

  server.handle(modelConfigsList, async () => {
    await ensureModelConfigsLoaded();
    return { configs: listModelConfigs() };
  });

  server.handle(threadsAsk, async (input, { paseo }) => {
    reapOnce(paseo);
    const values = await readSettings();
    const result = await askThread(paseo, values, input);
    await rememberEffectiveConfig(values, result.effectiveConfig);
    return {
      threadId: result.threadId,
      agentId: result.agentId,
      created: result.created,
      behavior: result.behavior,
    };
  });

  server.handle(threadsArchive, async (input, { paseo }) => {
    await archiveThread(paseo, input.threadId);
    return { ok: true };
  });

  server.handle(threadsRemove, async (input, { paseo }) => {
    await removeThread(paseo, input.threadId);
    return { ok: true };
  });

  server.handle(uploadsForMessage, async (input) => ({
    attachments: await readMessageAttachments(input.threadId, input.messageId),
  }));

  server.handle(threadsRename, async (input, { paseo }) => {
    await renameThread(paseo, input.threadId, input.title);
    return { ok: true };
  });

  server.handle(threadsPin, async (input, { paseo }) => {
    await pinThread(paseo, input.threadId, input.pinned);
    return { ok: true };
  });

  server.handle(threadsRebuild, async (input, { paseo }) => {
    const values = await readSettings();
    const result = await rebuildThread(
      paseo,
      values,
      input.threadId,
      input.question,
      input.model,
      input.thinkingOptionId,
      input.modeId,
      input.featureValues,
      input.attachments,
    );
    await rememberEffectiveConfig(values, result.effectiveConfig);
    return { threadId: result.threadId, agentId: result.agentId };
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

  server.handle(updateCheck, async () => checkUpdate());

  return () => {
    disposePermissionHooks();
    void flushSave().catch(() => {});
    void flushModelConfigsSave().catch(() => {});
  };
}
