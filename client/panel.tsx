import type { PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { useAgent, usePaseo, useRpc, useSettings } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import {
  threadsArchive,
  threadsAsk,
  threadsCancel,
  threadsList,
  threadsRebuild,
  threadsRename,
  updateCheck,
  type ThreadRuntimeStatus,
  type ThreadView,
} from "../shared/contracts";
import { PLUGIN_VERSION } from "../shared/meta";
import { sidekickSettings } from "../shared/settings";
import { copyText, FlatList, Icon, openExternalUrl, ScrollView, TextInput, useToast } from "./host-ui";
import { OverlaySheet } from "./overlay";
import { localizeServerMessage, useLocale, useT } from "./i18n";
import { openSidekickSettings } from "./ui-registration";
import { useThreadStream } from "./live/store";
import { LiveItemView, PermissionBanner, TurnStatusLine } from "./transcript/items";

/** 反馈入口：GitHub 新建 issue（提问题 / 提功能）。 */
const FEEDBACK_URL = "https://github.com/CasonMo/paseo-bytheway/issues/new";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function newRequestId(): string {
  return `skreq_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function modeLabel(mode: "ask" | "work"): string {
  return mode === "work" ? "Build" : "Chat";
}

/** Tab / 列表里展示时去掉标题前缀。 */
function stripThreadPrefix(title: string): string {
  return title.replace(/^\[侧聊(·Build)?\]\s*/, "");
}

interface ModelOption {
  id: string;
  label: string;
}

export function SidekickPanel({ theme, layout, host, agentId, navigation }: PluginAgentPanelProps) {
  const paseo = usePaseo();
  const toast = useToast();
  const compact = layout.compact;

  const listRpc = useRpc(threadsList);
  const askRpc = useRpc(threadsAsk);
  const archiveRpc = useRpc(threadsArchive);
  const cancelRpc = useRpc(threadsCancel);
  const rebuildRpc = useRpc(threadsRebuild);
  const renameRpc = useRpc(threadsRename);
  const updateRpc = useRpc(updateCheck);

  const settingsState = useSettings(sidekickSettings);
  const defaultMode = settingsState.status === "ready" ? settingsState.values.defaultMode : "ask";
  const experimentalCancel = settingsState.status === "ready" ? settingsState.values.experimentalCancel : true;
  const locale = useLocale();
  const t = useT();
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<{ latest: string; requiredPaseo: string | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await updateRpc({});
        if (cancelled) return;
        if (result.updateAvailable && result.latest) {
          setUpdateInfo({ latest: result.latest, requiredPaseo: result.requiredPaseo });
        }
      } catch {
        // 检查失败不打扰
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [updateRpc]);

  const mainAgent = useAgent(agentId, (value) => ({
    title: value.title,
    provider: value.provider,
    model: value.model,
  }));

  /* ---------------- 线程数据 ---------------- */

  const [threads, setThreads] = useState<ThreadView[]>([]);
  const [threadStatuses, setThreadStatuses] = useState<Record<string, ThreadRuntimeStatus>>({});
  const [selectedId, setSelectedId] = useState<string | null | undefined>(undefined);
  const [threadModalOpen, setThreadModalOpen] = useState(false);
  const [threadQuery, setThreadQuery] = useState("");
  const [renameTarget, setRenameTarget] = useState<ThreadView | null>(null);
  const [renameText, setRenameText] = useState("");

  const refresh = useCallback(async () => {
    try {
      const result = await listRpc({ mainAgentId: agentId });
      setThreads(result.threads);
      setThreadStatuses(result.threadStatuses ?? {});
      setSelectedId((current) => {
        // null = 用户主动处于「新会话」状态（点了 +），刷新时绝不自动跳走。
        if (current === null) return null;
        if (current && result.threads.some((thread) => thread.id === current)) return current;
        // undefined（未决）或选中线程已失效：回落到第一个可用线程。
        return result.threads.find((thread) => thread.state === "open")?.id ?? undefined;
      });
    } catch {
      // daemon 暂不可用：保留现有列表
    }
  }, [listRpc, agentId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 20_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const selected = useMemo(
    () => threads.find((thread) => thread.id === selectedId) ?? null,
    [threads, selectedId],
  );

  /** 服务端权威的线程运行态（列表 RPC 轮询 + running 标记）。 */
  const statusOf = (thread: ThreadView): ThreadRuntimeStatus =>
    threadStatuses[thread.id] ?? (thread.state === "open" ? "idle" : "closed");
  const agentRunning = selected ? statusOf(selected) === "running" : false;

  const streamAgentId = selected && selected.state === "open" ? selected.agentId : null;
  const stream = useThreadStream(streamAgentId);
  const turn = stream.state.turn;
  const busy = turn.status === "running";
  /** 权威忙碌态：流状态与服务端列表任一为运行中即认为在跑。 */
  const running = busy || agentRunning;
  const connection = stream.state.connection;

  // turn 结束后刷新一次，让状态圆点尽快更新
  useEffect(() => {
    if (turn.status === "completed" || turn.status === "failed" || turn.status === "canceled") {
      void refresh();
    }
  }, [turn.status, refresh]);

  /* ---------------- 滚动跟随 ---------------- */

  const listRef = useRef<{ scrollToEnd?: (options?: { animated?: boolean }) => void } | null>(null);
  const followRef = useRef(true);
  const lastOffsetRef = useRef(0);
  const lastContentHeightRef = useRef(0);
  const [showJump, setShowJump] = useState(false);

  const scrollToBottom = useCallback((animated: boolean) => {
    listRef.current?.scrollToEnd?.({ animated });
  }, []);

  const onScroll = useCallback(
    (event: {
      nativeEvent: {
        contentOffset: { y: number };
        layoutMeasurement: { height: number };
        contentSize: { height: number };
      };
    }) => {
      const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
      const y = contentOffset.y;
      const previous = lastOffsetRef.current;
      const height = contentSize.height;
      const previousHeight = lastContentHeightRef.current;
      lastOffsetRef.current = y;
      lastContentHeightRef.current = height;
      const contentShrank = height < previousHeight - 2;
      // 用户上滚（y 减小、非高度收缩）→ 立即放弃跟随，翻历史绝不会被拉回。
      if (y < previous - 1 && !contentShrank) {
        if (followRef.current) {
          followRef.current = false;
          setShowJump(true);
        }
        return;
      }
      // 向下滚回接近底部（40px 内）→ 自动恢复跟随；程序性贴底只会朝此方向，不会误停。
      if (y > previous + 1 && y + layoutMeasurement.height >= height - 40) {
        if (!followRef.current) {
          followRef.current = true;
          setShowJump(false);
        }
      }
    },
    [],
  );

  const items = stream.state.items;

  // 切换线程：重置为贴底
  useEffect(() => {
    followRef.current = true;
    setShowJump(false);
    lastOffsetRef.current = 0;
    lastContentHeightRef.current = 0;
    scrollToBottom(false);
  }, [selectedId, scrollToBottom]);

  // 新内容 / 回合状态变化：只要用户没有手动上滑，始终保持在底部
  useEffect(() => {
    if (followRef.current) scrollToBottom(false);
  }, [items, turn.status, scrollToBottom]);

  // 流式期间持续贴底：覆盖揭示节奏（pacing）带来的持续增高
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => {
      if (followRef.current) scrollToBottom(false);
    }, 350);
    return () => clearInterval(timer);
  }, [busy, scrollToBottom]);

  /* ---------------- 输入区状态 ---------------- */

  const [input, setInput] = useState("");
  const [mode, setMode] = useState<"ask" | "work">(defaultMode);
  const [modelOverride, setModelOverride] = useState<string | null>(null);
  const [providerCatalog, setProviderCatalog] = useState<
    Array<{ id: string; label: string; models: ModelOption[] }>
  >([]);
  const [pickerProvider, setPickerProvider] = useState<string | null>(null);
  const [modelModalOpen, setModelModalOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stopHint, setStopHint] = useState<string | null>(null);
  const [responding, setResponding] = useState(false);

  useEffect(() => {
    setMode(selected?.mode ?? defaultMode);
    setModelOverride(null);
    setStopHint(null);
    setSendError(null);
  }, [selectedId, selected?.mode, defaultMode]);

  // 跨 Provider 模型目录：一次 snapshot 取全部，失败时退回主会话 provider
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      type SnapshotEntry = {
        provider: string;
        label?: string;
        enabled?: boolean;
        status?: string;
        models?: Array<{ id: string; label: string; isSelectable?: boolean }>;
      };
      try {
        const result = await paseo.providers.snapshot();
        const entries = ((result as unknown as { entries?: SnapshotEntry[] }).entries ?? [])
          .filter((entry) => entry.enabled !== false && entry.status === "ready")
          .map((entry) => ({
            id: entry.provider,
            label: entry.label || entry.provider,
            models: (entry.models ?? [])
              .filter((model) => model.isSelectable !== false)
              .map((model) => ({ id: model.id, label: model.label })),
          }))
          .filter((entry) => entry.models.length > 0);
        if (entries.length > 0) {
          if (!cancelled) setProviderCatalog(entries);
          return;
        }
        throw new Error("snapshot empty");
      } catch {
        const provider = mainAgent?.provider;
        if (!provider) {
          if (!cancelled) setProviderCatalog([]);
          return;
        }
        try {
          const result = await paseo.providers.listModels(provider);
          const models = (result.models ?? [])
            .filter((model) => model.isSelectable !== false)
            .map((model) => ({ id: model.id, label: model.label }));
          if (!cancelled) setProviderCatalog([{ id: provider, label: provider, models }]);
        } catch {
          if (!cancelled) setProviderCatalog([]);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [paseo, mainAgent?.provider]);

  const splitModel = (value: string): { provider: string | null; model: string } => {
    const slash = value.indexOf("/");
    return slash > 0 ? { provider: value.slice(0, slash), model: value.slice(slash + 1) } : { provider: null, model: value };
  };
  const overrideSplit = modelOverride ? splitModel(modelOverride) : null;
  const providerLocked = selected != null;
  const lockedProvider = selected?.provider ?? null;
  const modelChangedSameProvider =
    selected != null &&
    overrideSplit != null &&
    overrideSplit.provider === selected.provider &&
    overrideSplit.model !== selected.model;
  const modelChangedOtherProvider =
    selected != null &&
    overrideSplit != null &&
    overrideSplit.provider != null &&
    overrideSplit.provider !== selected.provider;
  const modeChanged = selected != null && selected.state === "open" && mode !== selected.mode;
  // 同一 Provider 换模型 = 原地切换；模式切换 = 随消息携带指令；跨 Provider 仅新线程可用
  const willContinue =
    Boolean(selected) && selected?.state === "open" && !modelChangedOtherProvider;

  // 底部提示：仅在有实际指导意义时显示（继续现有线程时不再显示"将发送到…"）
  const hintText = running
    ? null
    : selected && selected.state === "stopped"
      ? t.willRebuild
      : selected && selected.state === "open" && modelChangedOtherProvider
        ? t.willNewThreadChanged
        : selected && selected.state === "open" && modelChangedSameProvider
          ? t.willSwitchModel(overrideSplit?.model ?? "")
          : selected && modeChanged
            ? t.willSwitchMode(modeLabel(mode))
            : !selected
              ? t.willNewThread
              : null;

  const send = useCallback(async () => {
    const question = input.trim();
    if (!question || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const result =
        selected && selected.state === "stopped"
          ? await rebuildRpc({ threadId: selected.id, question, model: modelOverride ?? undefined })
          : await askRpc({
              mainAgentId: agentId,
              question,
              mode,
              target: willContinue && selected ? { kind: "continue", threadId: selected.id } : { kind: "new" },
              model: modelOverride ?? undefined,
              continuationOf:
                !willContinue && selected && selected.state === "open" ? selected.agentId : undefined,
              clientRequestId: newRequestId(),
            });
      setInput("");
      followRef.current = true;
      setShowJump(false);
      await refresh();
      setSelectedId(result.threadId);
      if ("behavior" in result && result.behavior === "interrupt") {
        toast.show(t.sentInterruptToast, { variant: "info" });
      }
    } catch (error) {
      setSendError(messageOf(error));
    } finally {
      setSending(false);
    }
  }, [input, sending, askRpc, rebuildRpc, agentId, mode, willContinue, selected, modelOverride, refresh, toast, t]);

  // 对齐 Paseo 主输入框：web 上 Enter 发送、Shift+Enter 换行（跳过 IME 组字）
  const onComposerKeyPress = useCallback(
    (event: { nativeEvent: { key: string }; preventDefault?: () => void }) => {
      const native = event.nativeEvent as typeof event.nativeEvent & {
        shiftKey?: boolean;
        isComposing?: boolean;
        keyCode?: number;
      };
      if (native.isComposing || native.keyCode === 229) return;
      if (native.key !== "Enter" || native.shiftKey) return;
      event.preventDefault?.();
      void send();
    },
    [send],
  );

  const stop = useCallback(async () => {
    if (!selected || stopping) return;
    setStopping(true);
    setStopHint(null);
    try {
      if (!experimentalCancel) {
        setStopHint(t.stopIneffective);
        return;
      }
      const result = await cancelRpc({ threadId: selected.id });
      if (!result.requested) {
        setStopHint(result.note);
        return;
      }
      const startedAt = Date.now();
      let stopped = false;
      while (Date.now() - startedAt < 5000) {
        const snapshot = await paseo.agents.ref(selected.agentId).refresh();
        if (!snapshot || snapshot.agent.status !== "running") {
          stopped = true;
          break;
        }
        await sleep(900);
      }
      if (stopped) {
        toast.show(t.stoppedToast, { variant: "success" });
        void stream.refetch();
      } else {
        setStopHint(t.stopIneffective);
      }
    } catch (error) {
      setStopHint(messageOf(error));
    } finally {
      setStopping(false);
    }
  }, [selected, stopping, cancelRpc, paseo, toast, stream, t, experimentalCancel]);

  const archiveSelected = useCallback(
    async (threadId: string) => {
      try {
        await archiveRpc({ threadId });
        // 归档的是当前线程：先清选中，refresh 会落到下一个 open 线程（没有则新建态）
        setSelectedId((current) => (current === threadId ? undefined : current));
        toast.show(t.archivedToast, { variant: "info" });
        await refresh();
      } catch (error) {
        toast.error(t.archiveFailed(messageOf(error)));
      }
    },
    [archiveRpc, toast, refresh, t],
  );

  const saveRename = useCallback(async () => {
    const target = renameTarget;
    const title = renameText.trim();
    if (!target || !title) return;
    try {
      await renameRpc({ threadId: target.id, title });
      toast.show(t.renamedToast, { variant: "success" });
      setRenameTarget(null);
      await refresh();
    } catch (error) {
      toast.error(t.renameFailed(messageOf(error)));
    }
  }, [renameTarget, renameText, renameRpc, toast, refresh, t]);

  const onRespondPermission = useCallback(
    async (response: {
      behavior: "allow" | "deny";
      selectedActionId?: string;
      updatedInput?: Record<string, unknown>;
    }) => {
      const pending = stream.state.permissions[0];
      if (!pending || responding) return;
      setResponding(true);
      try {
        await stream.respondPermission(pending.id, response);
      } catch (error) {
        toast.error(t.permissionFailed(messageOf(error)));
      } finally {
        setResponding(false);
      }
    },
    [stream, responding, toast, t],
  );

  /* ---------------- 样式 ---------------- */

  const styles = useMemo(
    () => ({
      root: { flex: 1, backgroundColor: theme.colors.surface0 },
      header: {
        paddingHorizontal: compact ? 12 : 14,
        paddingVertical: 6,
        gap: 6,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      },
      headerRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      title: { color: theme.colors.foreground, fontSize: compact ? 12.5 : 13, fontWeight: "600" as const },
      muted: { color: theme.colors.foregroundMuted, fontSize: compact ? 10.5 : 11 },
      tab: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 4,
        borderRadius: 7,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        paddingHorizontal: 8,
        paddingVertical: 4,
        flexShrink: 1,
      },
      iconButton: {
        borderRadius: 7,
        borderWidth: 1,
        borderColor: theme.colors.border,
        paddingHorizontal: 7,
        paddingVertical: 4,
        alignItems: "center" as const,
        justifyContent: "center" as const,
      },
      transcript: { flex: 1 },
      transcriptContent: {
        paddingHorizontal: compact ? 12 : 16,
        paddingVertical: 10,
        gap: compact ? 8 : 10,
      },
      composer: {
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
        paddingHorizontal: compact ? 12 : 14,
        paddingVertical: 8,
        gap: 6,
        backgroundColor: theme.colors.surface0,
      },
      input: {
        minHeight: 36,
        maxHeight: 140,
        borderRadius: 9,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        color: theme.colors.foreground,
        paddingHorizontal: 10,
        paddingVertical: 8,
        fontSize: compact ? 12.5 : 13,
      },
      chip: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 4,
        borderRadius: 7,
        borderWidth: 1,
        borderColor: theme.colors.border,
        paddingHorizontal: 8,
        paddingVertical: 4,
        flexShrink: 0,
      },
      composerRow: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        alignItems: "center" as const,
        gap: 6,
      },
      modelChip: {
        flexShrink: 1,
        minWidth: 0,
        maxWidth: 200,
      },
      modelChipText: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        flexShrink: 1,
        minWidth: 0,
      },
      composerAction: {
        flexShrink: 0,
      },
      primaryButton: {
        borderRadius: 8,
        backgroundColor: theme.colors.accent,
        paddingHorizontal: 14,
        paddingVertical: 7,
        alignItems: "center" as const,
        justifyContent: "center" as const,
      },
      stopButton: {
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.statusDanger,
        paddingHorizontal: 12,
        paddingVertical: 6,
        alignItems: "center" as const,
        justifyContent: "center" as const,
      },
      modalRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 9,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      },
      backToBottom: {
        position: "absolute" as const,
        alignSelf: "center" as const,
        bottom: 12,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
        paddingHorizontal: 12,
        paddingVertical: 5,
      },
    }),
    [theme, compact],
  );

  const statusMetaOf = (status: ThreadRuntimeStatus): { color: string; label: string } => {
    switch (status) {
      case "running":
        return { color: theme.colors.accent, label: t.statusRunning };
      case "idle":
        return { color: theme.colors.statusSuccess, label: t.statusIdle };
      case "initializing":
        return { color: theme.colors.statusWarning, label: t.statusInitializing };
      case "error":
        return { color: theme.colors.statusDanger, label: t.statusError };
      default:
        return { color: theme.colors.foregroundMuted, label: t.statusStopped };
    }
  };

  const connectionMeta = useMemo(() => {
    switch (connection) {
      case "live":
        return { color: theme.colors.statusSuccess, label: t.connLive };
      case "restored":
        return { color: theme.colors.statusWarning, label: t.connRestored };
      case "error":
        return { color: theme.colors.statusDanger, label: t.connError };
      default:
        return { color: theme.colors.foregroundMuted, label: t.connConnecting };
    }
  }, [connection, theme, t]);

  const tabThreads = useMemo(() => {
    const max = compact ? 2 : 3;
    // tab 行只展示 open 线程；已归档（stopped）的从「更多会话」进
    const open = threads.filter((thread) => thread.state === "open");
    const head = open.slice(0, max);
    if (selected && selected.state === "open" && !head.some((thread) => thread.id === selected.id)) {
      return [...open.slice(0, max - 1), selected];
    }
    return head;
  }, [threads, selected, compact]);

  /** 重名线程自动加 #1/#2 后缀，避免无法区分。 */
  const titleSuffixes = useMemo(() => {
    const counts = new Map<string, number>();
    for (const thread of threads) {
      const base = stripThreadPrefix(thread.title);
      counts.set(base, (counts.get(base) ?? 0) + 1);
    }
    const seen = new Map<string, number>();
    const suffixes = new Map<string, string>();
    for (const thread of threads) {
      const base = stripThreadPrefix(thread.title);
      if ((counts.get(base) ?? 0) > 1) {
        const n = (seen.get(base) ?? 0) + 1;
        seen.set(base, n);
        suffixes.set(thread.id, `#${n}`);
      }
    }
    return suffixes;
  }, [threads]);

  const displayTitle = useCallback(
    (thread: ThreadView) => {
      const base = stripThreadPrefix(thread.title);
      const suffix = titleSuffixes.get(thread.id);
      return suffix ? `${base} ${suffix}` : base;
    },
    [titleSuffixes],
  );


  const filteredThreads = useMemo(() => {
    const query = threadQuery.trim().toLowerCase();
    if (!query) return threads;
    return threads.filter(
      (thread) =>
        thread.title.toLowerCase().includes(query) || thread.id.toLowerCase().includes(query),
    );
  }, [threads, threadQuery]);

  const effectivePickerProvider = providerLocked ? lockedProvider : pickerProvider;
  const pickerModels = useMemo(
    () => providerCatalog.find((entry) => entry.id === effectivePickerProvider)?.models ?? [],
    [providerCatalog, effectivePickerProvider],
  );

  const filteredModels = useMemo(() => {
    const query = modelQuery.trim().toLowerCase();
    if (!query) return pickerModels;
    return pickerModels.filter(
      (model) => model.label.toLowerCase().includes(query) || model.id.toLowerCase().includes(query),
    );
  }, [pickerModels, modelQuery]);

  const currentModelLabel =
    modelOverride ?? selected?.model ?? mainAgent?.model ?? t.followMain;

  /* ---------------- 渲染 ---------------- */

  return (
      <View style={styles.root}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <Text style={styles.title}>{t.panelTitle}</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: connectionMeta.color }} />
            <Text style={styles.muted}>{connectionMeta.label}</Text>
          </View>
          <View style={{ flex: 1 }} />
          <Pressable
            accessibilityRole="button"
            style={styles.iconButton}
            onPress={() => {
              if (!openSidekickSettings()) {
                toast.show(t.settingsFallbackHint, { variant: "info" });
              }
            }}
          >
            <Icon name="Settings" size={13} color={theme.colors.foreground} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            style={styles.iconButton}
            onPress={() => {
              setSelectedId(null);
              setInput("");
            }}
          >
            <Icon name="Plus" size={13} color={theme.colors.foreground} />
          </Pressable>
        </View>
        {updateInfo && !updateDismissed ? (
          <View
            style={{
              marginTop: 6,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: theme.colors.accent,
              backgroundColor: theme.colors.surface2,
              paddingHorizontal: 10,
              paddingVertical: 8,
              gap: 4,
            }}
          >
            <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
              {t.updateBannerTitle}
            </Text>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
              {t.updateBannerBody(
                PLUGIN_VERSION,
                updateInfo.latest,
                updateInfo.requiredPaseo ?? "?",
              )}
            </Text>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10.5, fontFamily: "Menlo" }}>
              paseo plugin update paseo-bytheway
            </Text>
            <Pressable
              accessibilityRole="button"
              style={{ alignSelf: "flex-end" }}
              onPress={() => setUpdateDismissed(true)}
            >
              <Text style={{ color: theme.colors.accent, fontSize: 11 }}>{t.updateBannerDismiss}</Text>
            </Pressable>
          </View>
        ) : null}
        <View style={styles.headerRow}>
          {threads.length === 0 ? (
            <Text style={styles.muted}>{t.noThreads}</Text>
          ) : (
            <>
              {tabThreads.map((thread) => {
                const active = thread.id === selectedId;
                const meta = statusMetaOf(statusOf(thread));
                return (
                  <Pressable
                    key={thread.id}
                    accessibilityRole="button"
                    style={[
                      styles.tab,
                      active ? { borderColor: theme.colors.accent, backgroundColor: theme.colors.surface2 } : null,
                    ]}
                    onPress={() => setSelectedId(thread.id)}
                  >
                    <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: meta.color }} />
                    <Text
                      numberOfLines={1}
                      style={{
                        color: active ? theme.colors.accent : theme.colors.foregroundMuted,
                        fontSize: compact ? 11 : 11.5,
                        maxWidth: compact ? 72 : 100,
                      }}
                    >
                      {displayTitle(thread)}
                    </Text>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t.closeTab}
                      hitSlop={6}
                      onPress={() => void archiveSelected(thread.id)}
                    >
                      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>✕</Text>
                    </Pressable>
                  </Pressable>
                );
              })}
              {threads.length > tabThreads.length ? (
                <Pressable accessibilityRole="button" style={styles.tab} onPress={() => setThreadModalOpen(true)}>
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{t.moreSessions} ⌄</Text>
                </Pressable>
              ) : (
                <Pressable
                  accessibilityRole="button"
                  style={[styles.tab, { borderStyle: "dashed" }]}
                  onPress={() => setThreadModalOpen(true)}
                >
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{t.moreSessions}</Text>
                </Pressable>
              )}
            </>
          )}
          <View style={{ flex: 1 }} />
          {selected ? (
            <Pressable
              accessibilityRole="button"
              style={styles.iconButton}
              onPress={() => navigation?.openAgent({ agentId: selected.agentId })}
            >
              <Text style={styles.muted}>{t.openTab}</Text>
            </Pressable>
          ) : null}
        </View>
        <View style={styles.headerRow}>
          <Text style={styles.muted}>
            {selected
              ? `${modeLabel(selected.mode)} · ${statusMetaOf(statusOf(selected)).label} · ${selected.model || t.followMain}`
              : `${modeLabel(mode)} · ${t.willNewThreadShort}`}
          </Text>
        </View>
      </View>

      {/* Transcript */}
      <View style={styles.transcript}>
        {!selected ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 6 }}>
            <Text style={{ color: theme.colors.foreground, fontSize: 13.5, fontWeight: "600" }}>
              {t.emptyTitle}
            </Text>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, textAlign: "center" }}>
              {t.emptyBody}
            </Text>
          </View>
        ) : selected.state !== "open" ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 8 }}>
            <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>{t.stoppedThread(selected.stateReason ?? t.statusStopped)}</Text>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11.5 }}>
              {t.stoppedThreadHint}
            </Text>
          </View>
        ) : (
          <View style={{ flex: 1 }}>
            <FlatList<(typeof items)[number]>
              ref={listRef as never}
              style={styles.transcript}
              contentContainerStyle={styles.transcriptContent}
              data={items}
              keyExtractor={(item) => item.key}
              renderItem={({ item }) => <LiveItemView item={item} theme={theme} compact={compact} />}
              onScroll={onScroll}
              scrollEventThrottle={100}
              onContentSizeChange={() => {
                if (followRef.current) scrollToBottom(false);
              }}
              ListFooterComponent={
                <View style={{ paddingTop: 6, paddingBottom: 40, gap: 6 }}>
                  <TurnStatusLine turn={turn} agentRunning={agentRunning} theme={theme} compact={compact} />
                </View>
              }
              ListEmptyComponent={
                <View style={{ paddingTop: 32, gap: 6, alignItems: "center" }}>
                  {agentRunning ? (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: theme.colors.accent }} />
                      <Text style={styles.muted}>{t.thinking}</Text>
                    </View>
                  ) : (
                    <Text style={styles.muted}>{t.emptyTranscript}</Text>
                  )}
                </View>
              }
            />
            {showJump ? (
              <Pressable
                accessibilityRole="button"
                style={styles.backToBottom}
                onPress={() => {
                  followRef.current = true;
                  setShowJump(false);
                  // 瞬时跳底：平滑动画的过冲回弹会产生 y 减小帧，被滚动监听误判为用户上滚。
                  scrollToBottom(false);
                }}
              >
                <Text style={{ color: theme.colors.foreground, fontSize: 11 }}>{t.jumpToBottom}</Text>
              </Pressable>
            ) : null}
          </View>
        )}
      </View>

      {/* Permission banner */}
      {stream.state.permissions.length > 0 && streamAgentId ? (
        <PermissionBanner
          key={stream.state.permissions[0].id}
          permission={stream.state.permissions[0]}
          theme={theme}
          compact={compact}
          responding={responding}
          onRespond={(response) => void onRespondPermission(response)}
        />
      ) : null}

      {/* Composer */}
      <View style={styles.composer}>
        <TextInput
          multiline
          style={styles.input}
          placeholder={selected && selected.state === "open" ? t.inputPlaceholderContinue : t.inputPlaceholderNew}
          placeholderTextColor={theme.colors.foregroundMuted}
          value={input}
          onChangeText={setInput}
          onKeyPress={Platform.OS === "web" ? onComposerKeyPress : undefined}
        />
        <View style={styles.composerRow}>
          <Pressable
            accessibilityRole="button"
            style={[styles.chip, mode === "ask" ? { borderColor: theme.colors.accent } : null]}
            onPress={() => setMode("ask")}
          >
            <Text style={{ color: mode === "ask" ? theme.colors.accent : theme.colors.foregroundMuted, fontSize: 11 }}>
              Chat
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            style={[styles.chip, mode === "work" ? { borderColor: theme.colors.accent } : null]}
            onPress={() => setMode("work")}
          >
            <Text style={{ color: mode === "work" ? theme.colors.accent : theme.colors.foregroundMuted, fontSize: 11 }}>
              Build
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            style={[styles.chip, styles.modelChip]}
            onPress={() => {
              const preferred =
                (providerLocked ? lockedProvider : null) ??
                overrideSplit?.provider ??
                selected?.provider ??
                mainAgent?.provider ??
                providerCatalog[0]?.id ??
                null;
              setPickerProvider(preferred);
              setModelModalOpen(true);
            }}
          >
            <Text numberOfLines={1} ellipsizeMode="tail" style={styles.modelChipText}>
              {currentModelLabel}
            </Text>
            <Icon name="ChevronDown" size={11} color={theme.colors.foregroundMuted} />
          </Pressable>
          <View style={{ flex: 1, minWidth: 4 }} />
          {running && streamAgentId ? (
            <Pressable
              accessibilityRole="button"
              style={[styles.stopButton, styles.composerAction]}
              onPress={() => void stop()}
              disabled={stopping}
            >
              <Text style={{ color: theme.colors.statusDanger, fontSize: 12, fontWeight: "600" }}>
                {stopping ? t.stopping : t.stop}
              </Text>
            </Pressable>
          ) : (
            <Pressable
              accessibilityRole="button"
              style={[
                styles.primaryButton,
                styles.composerAction,
                (!input.trim() || sending || selected?.state === "stopped") && { opacity: 0.5 },
              ]}
              onPress={() => void send()}
              disabled={!input.trim() || sending}
            >
              <Text style={{ color: theme.colors.accentForeground, fontSize: 12, fontWeight: "600" }}>
                {sending ? t.sending : t.send}
              </Text>
            </Pressable>
          )}
        </View>
        <View style={{ gap: 2 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            {hintText ? <Text style={[styles.muted, { flexShrink: 1 }]}>{hintText}</Text> : null}
            <View style={{ flex: 1 }} />
            <Pressable
              accessibilityRole="link"
              hitSlop={6}
              onPress={() => {
                void openExternalUrl(FEEDBACK_URL).catch(() => {
                  toast.error(t.linkOpenFailed);
                });
              }}
            >
              <Text
                style={{
                  color: theme.colors.foregroundMuted,
                  fontSize: 10.5,
                  textDecorationLine: "underline",
                }}
              >
                {t.feedbackIssue}
              </Text>
            </Pressable>
          </View>
          {sendError ? <Text style={{ color: theme.colors.statusDanger, fontSize: 11 }}>{localizeServerMessage(sendError, locale)}</Text> : null}
          {stopHint ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={{ color: theme.colors.statusWarning, fontSize: 11, flex: 1 }}>{localizeServerMessage(stopHint, locale)}</Text>
              {selected ? (
                <Pressable accessibilityRole="button" onPress={() => navigation?.openAgent({ agentId: selected.agentId })}>
                  <Text style={{ color: theme.colors.accent, fontSize: 11 }}>{t.openTab}</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
        </View>
      </View>

      {/* 线程选择弹层 */}
      <OverlaySheet open={threadModalOpen} onClose={() => setThreadModalOpen(false)} title={t.threadsSheet} theme={theme}>
        <ScrollView style={{ maxHeight: 420 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 8 }}>
          <TextInput
            style={[styles.input, { minHeight: 32, maxHeight: 32 }]}
            placeholder={t.searchThreads}
            placeholderTextColor={theme.colors.foregroundMuted}
            value={threadQuery}
            onChangeText={setThreadQuery}
          />
          {filteredThreads.map((thread) => (
            <Pressable
              key={thread.id}
              accessibilityRole="button"
              style={[
                styles.modalRow,
                thread.id === selectedId
                  ? { backgroundColor: theme.colors.surface2, borderLeftWidth: 2, borderLeftColor: theme.colors.accent }
                  : null,
              ]}
              onPress={() => {
                setSelectedId(thread.id);
                setThreadModalOpen(false);
              }}
            >
              <View style={{ flex: 1, gap: 2 }}>
                <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 12.5 }}>
                  {thread.pinned ? "📌 " : ""}
                  {displayTitle(thread)}
                </Text>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                  <View
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 3,
                      backgroundColor: statusMetaOf(statusOf(thread)).color,
                    }}
                  />
                  <Text style={styles.muted}>
                    {modeLabel(thread.mode)} · {statusMetaOf(statusOf(thread)).label}
                    {thread.model ? ` · ${thread.model}` : ""}
                  </Text>
                </View>
              </View>
              {thread.id === selectedId ? (
                <Text style={{ color: theme.colors.accent, fontSize: 10.5 }}>{t.currentBadge}</Text>
              ) : null}
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  void (async () => {
                    try {
                      await copyText(thread.agentId);
                      toast.show(t.copied, { variant: "success" });
                    } catch {
                      toast.error(t.copyFailed);
                    }
                  })();
                }}
                hitSlop={8}
              >
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{t.copyId}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  setRenameTarget(thread);
                  setRenameText(stripThreadPrefix(thread.title));
                }}
                hitSlop={8}
              >
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{t.rename}</Text>
              </Pressable>
              {thread.state === "open" ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void archiveSelected(thread.id)}
                  hitSlop={8}
                >
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{t.archive}</Text>
                </Pressable>
              ) : null}
            </Pressable>
          ))}
          {filteredThreads.length === 0 ? <Text style={styles.muted}>{t.noThreadMatches}</Text> : null}
        </ScrollView>
      </OverlaySheet>

      {/* 模型选择弹层 */}
      <OverlaySheet open={modelModalOpen} onClose={() => setModelModalOpen(false)} title={t.modelsSheet} theme={theme}>
        <ScrollView style={{ maxHeight: 420 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 8 }}>
          <TextInput
            style={[styles.input, { minHeight: 32, maxHeight: 32 }]}
            placeholder={t.searchModels}
            placeholderTextColor={theme.colors.foregroundMuted}
            value={modelQuery}
            onChangeText={setModelQuery}
          />
          {providerLocked ? (
            <Text style={styles.muted}>
              {t.providerLocked(
                providerCatalog.find((entry) => entry.id === lockedProvider)?.label ?? lockedProvider ?? "",
              )}
            </Text>
          ) : (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {providerCatalog.map((entry) => {
                const active = entry.id === pickerProvider;
                return (
                  <Pressable
                    key={entry.id}
                    accessibilityRole="button"
                    style={[styles.chip, active ? { borderColor: theme.colors.accent } : null]}
                    onPress={() => setPickerProvider(entry.id)}
                  >
                    <Text style={{ color: active ? theme.colors.accent : theme.colors.foregroundMuted, fontSize: 11 }}>
                      {entry.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          )}
          <Text style={styles.muted}>{t.modelsSheetHint}</Text>
          {!providerLocked ? (
            <Pressable
              accessibilityRole="button"
              style={styles.modalRow}
              onPress={() => {
                setModelOverride(null);
                setModelModalOpen(false);
              }}
            >
              <Text style={{ color: theme.colors.foreground, fontSize: 12.5 }}>
                {t.followMain}
                {mainAgent?.model ? `（${mainAgent.model}）` : ""}
              </Text>
            </Pressable>
          ) : null}
          {filteredModels.map((model) => (
            <Pressable
              key={model.id}
              accessibilityRole="button"
              style={styles.modalRow}
              onPress={() => {
                if (!effectivePickerProvider) return;
                // 统一存 "provider/model"：provider 恒为第一段，兼容含 "/" 的模型 id
                setModelOverride(`${effectivePickerProvider}/${model.id}`);
                setModelModalOpen(false);
              }}
            >
              <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 12.5 }}>
                {model.label}
              </Text>
            </Pressable>
          ))}
          {filteredModels.length === 0 ? <Text style={styles.muted}>{t.noModels}</Text> : null}
        </ScrollView>
      </OverlaySheet>

      {/* 重命名浮层 */}
      <OverlaySheet
        open={renameTarget !== null}
        onClose={() => setRenameTarget(null)}
        title={t.renameSheet}
        theme={theme}
      >
        <View style={{ gap: 10 }}>
          <TextInput
            style={[styles.input, { minHeight: 34, maxHeight: 34 }]}
            value={renameText}
            onChangeText={setRenameText}
            placeholder={t.threadNamePlaceholder}
            placeholderTextColor={theme.colors.foregroundMuted}
          />
          <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
            <Pressable accessibilityRole="button" style={styles.chip} onPress={() => setRenameTarget(null)}>
              <Text style={styles.muted}>{t.cancel}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" style={styles.primaryButton} onPress={() => void saveRename()}>
              <Text style={{ color: theme.colors.accentForeground, fontSize: 12, fontWeight: "600" }}>{t.save}</Text>
            </Pressable>
          </View>
        </View>
      </OverlaySheet>
      </View>
  );
}
