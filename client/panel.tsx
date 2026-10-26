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
import {
  resolveThinkingRequest,
  thinkingChoiceForModelTarget,
  type ThinkingChoice,
} from "../shared/thinking";
import {
  mergeFeatureDefaults,
  sameFeatureValues,
  snapshotFeatureValues,
  threadModeForProviderMode,
  type ProviderFeatureLike,
  type ProviderModeLike,
} from "../shared/controls";
import { copyText, FlatList, Icon, openExternalUrl, ScrollView, TextInput, useToast } from "./host-ui";
import { OverlaySheet } from "./overlay";
import { localizeServerMessage, useLocale, useT } from "./i18n";
import { onThreadFocusRequest, peekPendingThreadFocus, takePendingThreadFocus } from "./panel-focus";
import { bottomOffset, nextScrollFollow } from "./scroll-follow";
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

/** Tab / 列表里展示时去掉标题前缀。 */
function stripThreadPrefix(title: string): string {
  return title.replace(/^\[侧聊(·Build)?\]\s*/, "");
}

interface ThinkingOption {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
}

interface ModelOption {
  id: string;
  label: string;
  thinkingOptions?: ThinkingOption[];
  defaultThinkingOptionId?: string;
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
    cwd: value.cwd,
    currentModeId: value.currentModeId,
    thinkingOptionId: value.thinkingOptionId,
  }));
  const [mainRuntime, setMainRuntime] = useState<{
    modeId: string | null;
    featureValues: Record<string, unknown>;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void paseo.agents
      .ref(agentId)
      .refresh()
      .then((snapshot) => {
        if (cancelled || !snapshot) return;
        setMainRuntime({
          modeId: snapshot.agent.currentModeId ?? null,
          featureValues: snapshotFeatureValues(snapshot.agent.features),
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [paseo, agentId]);

  /* ---------------- 线程数据 ---------------- */

  const [threads, setThreads] = useState<ThreadView[]>([]);
  const [threadStatuses, setThreadStatuses] = useState<Record<string, ThreadRuntimeStatus>>({});
  const [selectedId, setSelectedId] = useState<string | null | undefined>(undefined);
  const [threadModalOpen, setThreadModalOpen] = useState(false);
  const [threadQuery, setThreadQuery] = useState("");
  const [renameTarget, setRenameTarget] = useState<ThreadView | null>(null);
  const [renameText, setRenameText] = useState("");

  const refresh = useCallback(async (): Promise<ThreadView[] | null> => {
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
      return result.threads;
    } catch {
      // daemon 暂不可用：保留现有列表
      return null;
    }
  }, [listRpc, agentId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 20_000);
    return () => clearInterval(timer);
  }, [refresh]);

  // 命令创建/继续的线程：立即刷新列表并选中，不等 20s 轮询。
  // 覆盖两种场景：面板挂载时消费暂存请求；面板已打开时接收实时信号。
  useEffect(() => {
    let cancelled = false;
    let latestRequest = 0;

    const apply = async (threadId: string) => {
      const request = ++latestRequest;
      let list = await refresh();
      if (cancelled || request !== latestRequest) return;
      // 线程刚写入注册表时列表可能慢半拍，重试一次再放弃。
      if (!list?.some((thread) => thread.id === threadId)) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (cancelled || request !== latestRequest) return;
        list = await refresh();
      }
      if (cancelled || request !== latestRequest) return;
      if (!list?.some((thread) => thread.id === threadId)) return;
      setSelectedId(threadId);
      takePendingThreadFocus(agentId, threadId);
    };

    const initial = peekPendingThreadFocus(agentId);
    if (initial) void apply(initial);

    const unsubscribe = onThreadFocusRequest((request) => {
      if (request.mainAgentId !== agentId) return;
      void apply(request.threadId);
    });
    return () => {
      cancelled = true;
      latestRequest += 1;
      unsubscribe();
    };
  }, [agentId, refresh]);

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

  const listRef = useRef<{
    scrollToOffset?: (options: { offset: number; animated?: boolean }) => void;
  } | null>(null);
  const followRef = useRef(true);
  const lastOffsetRef = useRef(0);
  const lastContentHeightRef = useRef(0);
  const contentHeightRef = useRef(0);
  const viewportHeightRef = useRef(0);
  /** 我们自己发起的贴底目标；用于消费由此产生的 scroll 事件。 */
  const programmaticTargetRef = useRef<number | null>(null);
  const [showJump, setShowJump] = useState(false);

  /**
   * 用真实 contentSize/viewport 计算偏移，不再使用 FlatList.scrollToEnd()。
   * VirtualizedList.scrollToEnd() 依赖最后一个 cell 的已测量高度；流式 Markdown
   * 增高时该值会落后，目标可能落在当前底部之上，进而被 onScroll 误判成用户上滚。
   */
  const scrollToBottom = useCallback((animated: boolean) => {
    // 首次挂载尚无 contentSize 时不要误滚到顶部。
    if (contentHeightRef.current <= 0) return;
    const target = bottomOffset(contentHeightRef.current, viewportHeightRef.current);
    programmaticTargetRef.current = target;
    listRef.current?.scrollToOffset?.({ offset: target, animated });
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
      viewportHeightRef.current = layoutMeasurement.height;
      const result = nextScrollFollow({
        state: {
          following: followRef.current,
          previousOffset: lastOffsetRef.current,
          previousContentHeight: lastContentHeightRef.current,
        },
        sample: {
          offset: contentOffset.y,
          contentHeight: contentSize.height,
          viewportHeight: layoutMeasurement.height,
        },
        programmaticTarget: programmaticTargetRef.current,
      });
      if (result.programmaticHandled) programmaticTargetRef.current = null;
      lastOffsetRef.current = result.offset;
      lastContentHeightRef.current = result.contentHeight;
      if (followRef.current !== result.following) {
        followRef.current = result.following;
        setShowJump(result.jumpVisible);
        // 用户上滑或回到底部后，旧的程序目标不再可信。
        programmaticTargetRef.current = null;
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
    // 保留上一次 contentHeight：若新旧线程内容高度相同，onContentSizeChange
    // 可能不再触发；旧值用于立即滚底，浏览器会按新内容自动 clamp。
    programmaticTargetRef.current = null;
    scrollToBottom(false);
  }, [selectedId, scrollToBottom]);

  // 新内容 / 回合状态变化：只要用户没有手动上滑，始终保持在底部
  useEffect(() => {
    if (followRef.current) scrollToBottom(false);
  }, [items, turn.status, scrollToBottom]);

  // 运行中兜底贴底：覆盖流式布局的零散增高
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      if (followRef.current) scrollToBottom(false);
    }, 350);
    return () => clearInterval(timer);
  }, [running, scrollToBottom]);

  /* ---------------- 输入区状态 ---------------- */

  const [input, setInput] = useState("");
  const [modelOverride, setModelOverride] = useState<string | null>(null);
  const [thinkingChoice, setThinkingChoice] = useState<ThinkingChoice>({ mode: "follow" });
  const [thinkingModalOpen, setThinkingModalOpen] = useState(false);
  const [modeCatalog, setModeCatalog] = useState<ProviderModeLike[]>([]);
  const [featureCatalog, setFeatureCatalog] = useState<ProviderFeatureLike[]>([]);
  const [selectedModeId, setSelectedModeId] = useState<string | null>(null);
  const [featureValues, setFeatureValues] = useState<Record<string, unknown>>({});
  const [modeTouched, setModeTouched] = useState(false);
  const [featuresTouched, setFeaturesTouched] = useState(false);
  const [modeModalOpen, setModeModalOpen] = useState(false);
  const [featureModalId, setFeatureModalId] = useState<string | null>(null);
  const [controlsKey, setControlsKey] = useState<string | null>(null);
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
    setModelOverride(null);
    setStopHint(null);
    setSendError(null);
  }, [selectedId]);

  // 跨 Provider 模型目录：一次 snapshot 取全部，失败时退回主会话 provider
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      type SnapshotEntry = {
        provider: string;
        label?: string;
        enabled?: boolean;
        status?: string;
        models?: Array<{
          id: string;
          label: string;
          isSelectable?: boolean;
          thinkingOptions?: ThinkingOption[];
          defaultThinkingOptionId?: string;
        }>;
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
              .map((model) => ({
                id: model.id,
                label: model.label,
                thinkingOptions: model.thinkingOptions ?? [],
                ...(model.defaultThinkingOptionId ? { defaultThinkingOptionId: model.defaultThinkingOptionId } : {}),
              })),
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
            .map((model) => ({
              id: model.id,
              label: model.label,
              thinkingOptions: model.thinkingOptions ?? [],
              ...(model.defaultThinkingOptionId ? { defaultThinkingOptionId: model.defaultThinkingOptionId } : {}),
            }));
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
  const targetProvider = providerLocked
    ? (overrideSplit?.provider ?? selected?.provider ?? null)
    : (overrideSplit?.provider ?? mainAgent?.provider ?? null);
  const targetModel = providerLocked
    ? (overrideSplit?.model ?? selected?.model ?? "")
    : (overrideSplit?.model ?? mainAgent?.model ?? "");
  const targetMatchesMain =
    Boolean(mainAgent?.provider) &&
    targetProvider === mainAgent?.provider &&
    targetModel === (mainAgent?.model ?? "");
  const targetModelOption = providerCatalog
    .find((entry) => entry.id === targetProvider)
    ?.models.find((model) => model.id === targetModel);
  const targetThinkingOptions = targetModelOption?.thinkingOptions ?? [];
  const mainModelOption = providerCatalog
    .find((entry) => entry.id === mainAgent?.provider)
    ?.models.find((model) => model.id === (mainAgent?.model ?? ""));
  const mainThinkingOptionId =
    mainAgent?.thinkingOptionId ??
    mainModelOption?.defaultThinkingOptionId ??
    mainModelOption?.thinkingOptions?.find((option) => option.isDefault)?.id ??
    null;
  const mainThinkingLabel =
    mainModelOption?.thinkingOptions?.find((option) => option.id === mainThinkingOptionId)?.label ??
    mainThinkingOptionId;

  useEffect(() => {
    if (!selectedId) {
      setThinkingChoice({ mode: "follow" });
      return;
    }
    if (!selected) return;
    if (selected.thinkingOptionId) {
      setThinkingChoice({ mode: "option", id: selected.thinkingOptionId });
    } else {
      setThinkingChoice(thinkingChoiceForModelTarget(targetMatchesMain));
    }
  }, [
    selectedId,
    selected?.thinkingOptionId,
    selected?.provider,
    selected?.model,
    mainAgent?.provider,
    mainAgent?.model,
  ]);

  const targetKey = targetProvider && targetModel ? `${targetProvider}/${targetModel}` : null;
  const thinkingDraftOptionId =
    thinkingChoice.mode === "follow"
      ? targetMatchesMain
        ? mainThinkingOptionId
        : null
      : thinkingChoice.id;

  useEffect(() => {
    let cancelled = false;
    if (!targetProvider || !targetModel || !mainAgent?.cwd) {
      setModeCatalog([]);
      setFeatureCatalog([]);
      setControlsKey(null);
      return;
    }
    setFeatureCatalog([]);
    setControlsKey(null);
    const load = async () => {
      const [modeResult, featureResult] = await Promise.all([
        paseo.providers.listModes(targetProvider).catch(() => null),
        paseo.providers
          .listFeatures({
            provider: `${targetProvider}/${targetModel}`,
            cwd: mainAgent.cwd,
            ...(selectedModeId ? { modeId: selectedModeId } : {}),
            ...(thinkingDraftOptionId ? { thinkingOptionId: thinkingDraftOptionId } : {}),
          })
          .catch(() => null),
      ]);
      if (cancelled) return;
      setModeCatalog((modeResult?.modes ?? []) as ProviderModeLike[]);
      const features = (featureResult?.features ?? []) as ProviderFeatureLike[];
      setFeatureCatalog(features);
      setFeatureValues((current) => mergeFeatureDefaults(current, features));
      setControlsKey(`${targetProvider}/${targetModel}`);
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [
    paseo,
    targetProvider,
    targetModel,
    mainAgent?.cwd,
    selectedModeId,
    thinkingChoice.mode,
    thinkingDraftOptionId,
  ]);

  const selectedFeatureValuesKey = JSON.stringify(
    Object.entries(selected?.featureValues ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  );

  useEffect(() => {
    if (!selected) return;
    setSelectedModeId(selected.modeId ?? null);
    setFeatureValues(selected.featureValues ?? {});
    setModeTouched(false);
    setFeaturesTouched(false);
  }, [selectedId, selected?.modeId, selectedFeatureValuesKey]);

  useEffect(() => {
    if (selected) return;
    const followMain = targetMatchesMain;
    setSelectedModeId(
      followMain ? mainRuntime?.modeId ?? mainAgent?.currentModeId ?? null : null,
    );
    setFeatureValues(followMain ? mainRuntime?.featureValues ?? {} : {});
    setModeTouched(false);
    setFeaturesTouched(false);
  }, [selectedId, targetMatchesMain, mainRuntime, mainAgent?.currentModeId]);

  const thinkingOptionLabel = (id: string | null): string => {
    if (id === null) return t.thinkingDefault;
    return targetThinkingOptions.find((option) => option.id === id)?.label ?? id;
  };
  const thinkingChipLabel =
    thinkingChoice.mode === "follow"
      ? `${t.thinkingFollow}${mainThinkingLabel ? ` · ${mainThinkingLabel}` : ""}`
      : thinkingOptionLabel(thinkingChoice.id);

  const controlsReady = controlsKey === targetKey;
  const currentMode = modeCatalog.find((mode) => mode.id === selectedModeId) ?? null;
  const currentModeLabel = currentMode?.label ?? selectedModeId ?? t.providerDefault;
  const requestThreadMode =
    selected?.mode ?? (currentMode ? threadModeForProviderMode(currentMode) : "work");
  const modeControlChanged =
    selected?.state === "open" && (selectedModeId ?? null) !== (selected.modeId ?? null);
  const featureControlChanged =
    selected?.state === "open" &&
    controlsReady &&
    !sameFeatureValues(featureValues, selected?.featureValues ?? {});
  const controlsChanged = modeControlChanged || featureControlChanged;
  const featureModal =
    featureModalId === null
      ? null
      : featureCatalog.find((feature) => feature.id === featureModalId) ?? null;

  // 同一 Provider 换模型 = 原地切换；模式切换 = 随消息携带指令；跨 Provider 仅新线程可用
  const willContinue =
    Boolean(selected) && selected?.state === "open" && !modelChangedOtherProvider;
  const thinkingRequest = resolveThinkingRequest(
    thinkingChoice,
    mainThinkingOptionId,
    targetMatchesMain,
    selected?.thinkingOptionId,
  );
  const thinkingWillChange = selected?.state === "open" && thinkingRequest !== undefined;

  // 底部提示：仅在有实际指导意义时显示（继续现有线程时不再显示"将发送到…"）
  const hintText = running
    ? null
    : selected && selected.state === "stopped"
      ? t.willRebuild
      : selected && selected.state === "open" && modelChangedOtherProvider
        ? t.willNewThreadChanged
        : selected && selected.state === "open" && modelChangedSameProvider
          ? t.willSwitchModel(overrideSplit?.model ?? "")
          : selected && thinkingWillChange
            ? t.willSwitchThinking(
                thinkingRequest === null
                  ? t.thinkingDefault
                  : targetThinkingOptions.find((option) => option.id === thinkingRequest)?.label ??
                    thinkingRequest ??"",
              )
          : selected && controlsChanged
            ? t.willSwitchControls
            : !selected
              ? t.willNewThread
              : null;

  const followNewThreadConfig = !selected && targetMatchesMain;
  const sentModeId = followNewThreadConfig && !modeTouched ? undefined : selectedModeId;
  const sentFeatureValues =
    controlsReady && !(followNewThreadConfig && !featuresTouched) ? featureValues : undefined;

  const send = useCallback(async () => {
    const question = input.trim();
    if (!question || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const result =
        selected && selected.state === "stopped"
          ? await rebuildRpc({
              threadId: selected.id,
              question,
              model: modelOverride ?? undefined,
              modeId: sentModeId,
              ...(thinkingRequest !== undefined ? { thinkingOptionId: thinkingRequest } : {}),
              ...(sentFeatureValues !== undefined ? { featureValues: sentFeatureValues } : {}),
            })
          : await askRpc({
              mainAgentId: agentId,
              question,
              mode: requestThreadMode,
              target: willContinue && selected ? { kind: "continue", threadId: selected.id } : { kind: "new" },
              model: modelOverride ?? undefined,
              modeId: sentModeId,
              ...(thinkingRequest !== undefined ? { thinkingOptionId: thinkingRequest } : {}),
              ...(sentFeatureValues !== undefined ? { featureValues: sentFeatureValues } : {}),
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
  }, [
    input,
    sending,
    askRpc,
    rebuildRpc,
    agentId,
    requestThreadMode,
    willContinue,
    selected,
    modelOverride,
    sentModeId,
    thinkingRequest,
    sentFeatureValues,
    refresh,
    toast,
    t,
  ]);

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
      thinkingChip: {
        flexShrink: 1,
        minWidth: 0,
        maxWidth: 160,
      },
      thinkingChipText: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        flexShrink: 1,
        minWidth: 0,
      },
      controlChip: {
        flexShrink: 1,
        minWidth: 0,
        maxWidth: 180,
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
              ? `${currentModeLabel} · ${statusMetaOf(statusOf(selected)).label} · ${selected.model || t.followMain}`
              : `${currentModeLabel} · ${t.willNewThreadShort}`}
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
              onLayout={(event) => {
                viewportHeightRef.current = event.nativeEvent.layout.height;
                if (followRef.current) scrollToBottom(false);
              }}
              onScroll={onScroll}
              scrollEventThrottle={100}
              onContentSizeChange={(_width, height) => {
                contentHeightRef.current = height;
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
          {targetThinkingOptions.length > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t.thinkingLabel}
              style={[styles.chip, styles.thinkingChip]}
              onPress={() => setThinkingModalOpen(true)}
            >
              <Text numberOfLines={1} ellipsizeMode="tail" style={styles.thinkingChipText}>
                {`${t.thinkingLabel}: ${thinkingChipLabel}`}
              </Text>
              <Icon name="ChevronDown" size={11} color={theme.colors.foregroundMuted} />
            </Pressable>
          ) : null}
          {controlsReady && modeCatalog.length > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t.modeLabel}
              style={[styles.chip, styles.controlChip]}
              onPress={() => setModeModalOpen(true)}
            >
              <Text numberOfLines={1} ellipsizeMode="tail" style={styles.thinkingChipText}>
                {`${t.modeLabel}: ${currentModeLabel}`}
              </Text>
              <Icon name="ChevronDown" size={11} color={theme.colors.foregroundMuted} />
            </Pressable>
          ) : null}
          {controlsReady
            ? featureCatalog.map((feature) => {
                const value = featureValues[feature.id] ?? feature.value;
                if (feature.type === "toggle") {
                  const active = Boolean(value);
                  return (
                    <Pressable
                      key={feature.id}
                      accessibilityRole="button"
                      accessibilityLabel={feature.label}
                      style={[styles.chip, active ? { borderColor: theme.colors.accent } : null]}
                      onPress={() => {
                        setFeaturesTouched(true);
                        setFeatureValues((current) => ({ ...current, [feature.id]: !active }));
                      }}
                    >
                      <Text
                        style={{
                          color: active ? theme.colors.accent : theme.colors.foregroundMuted,
                          fontSize: 11,
                        }}
                      >
                        {feature.label}
                      </Text>
                    </Pressable>
                  );
                }
                const option = feature.options.find((candidate) => candidate.id === value);
                return (
                  <Pressable
                    key={feature.id}
                    accessibilityRole="button"
                    accessibilityLabel={feature.label}
                    style={[styles.chip, styles.controlChip]}
                    onPress={() => setFeatureModalId(feature.id)}
                  >
                    <Text numberOfLines={1} ellipsizeMode="tail" style={styles.thinkingChipText}>
                      {`${feature.label}: ${option?.label ?? value ?? t.providerDefault}`}
                    </Text>
                    <Icon name="ChevronDown" size={11} color={theme.colors.foregroundMuted} />
                  </Pressable>
                );
              })
            : null}
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
                    {thread.modeId ?? t.providerDefault} · {statusMetaOf(statusOf(thread)).label}
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
                setThinkingChoice(thinkingChoiceForModelTarget(true));
                setSelectedModeId(mainRuntime?.modeId ?? mainAgent?.currentModeId ?? null);
                setFeatureValues(mainRuntime?.featureValues ?? {});
                setModeTouched(false);
                setFeaturesTouched(false);
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
                const matchesMain =
                  effectivePickerProvider === mainAgent?.provider &&
                  model.id === (mainAgent?.model ?? "");
                // 统一存 "provider/model"：provider 恒为第一段，兼容含 "/" 的模型 id
                setModelOverride(`${effectivePickerProvider}/${model.id}`);
                setThinkingChoice(thinkingChoiceForModelTarget(matchesMain));
                setSelectedModeId(matchesMain ? mainRuntime?.modeId ?? mainAgent?.currentModeId ?? null : null);
                setFeatureValues(matchesMain ? mainRuntime?.featureValues ?? {} : {});
                setModeTouched(false);
                setFeaturesTouched(false);
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

      {/* 思考模式弹层 */}
      <OverlaySheet
        open={thinkingModalOpen}
        onClose={() => setThinkingModalOpen(false)}
        title={t.thinkingSheet}
        theme={theme}
      >
        <ScrollView style={{ maxHeight: 360 }} contentContainerStyle={{ gap: 4 }}>
          <Text style={[styles.muted, { paddingHorizontal: 12, paddingBottom: 6 }]}>{t.thinkingSheetHint}</Text>
          {targetMatchesMain ? (
            <Pressable
              accessibilityRole="button"
              style={styles.modalRow}
              onPress={() => {
                setThinkingChoice({ mode: "follow" });
                setThinkingModalOpen(false);
              }}
            >
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ color: theme.colors.foreground, fontSize: 12.5 }}>
                  {t.followMain}
                  {mainThinkingLabel ? `（${mainThinkingLabel}）` : ""}
                </Text>
                <Text style={styles.muted}>{t.thinkingFollowHint}</Text>
              </View>
              {thinkingChoice.mode === "follow" ? (
                <Text style={{ color: theme.colors.accent, fontSize: 13 }}>✓</Text>
              ) : null}
            </Pressable>
          ) : null}
          {!targetMatchesMain ? (
            <Pressable
              accessibilityRole="button"
              style={styles.modalRow}
              onPress={() => {
                setThinkingChoice({ mode: "option", id: null });
                setThinkingModalOpen(false);
              }}
            >
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ color: theme.colors.foreground, fontSize: 12.5 }}>{t.thinkingDefault}</Text>
                <Text style={styles.muted}>{t.thinkingDefaultHint}</Text>
              </View>
              {thinkingChoice.mode === "option" && thinkingChoice.id === null ? (
                <Text style={{ color: theme.colors.accent, fontSize: 13 }}>✓</Text>
              ) : null}
            </Pressable>
          ) : null}
          {targetThinkingOptions.map((option) => {
            const active = thinkingChoice.mode === "option" && thinkingChoice.id === option.id;
            return (
              <Pressable
                key={option.id}
                accessibilityRole="button"
                style={styles.modalRow}
                onPress={() => {
                  setThinkingChoice({ mode: "option", id: option.id });
                  setThinkingModalOpen(false);
                }}
              >
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={{ color: theme.colors.foreground, fontSize: 12.5 }}>{option.label}</Text>
                  {option.description ? <Text style={styles.muted}>{option.description}</Text> : null}
                </View>
                {active ? <Text style={{ color: theme.colors.accent, fontSize: 13 }}>✓</Text> : null}
              </Pressable>
            );
          })}
        </ScrollView>
      </OverlaySheet>

      {/* Provider mode 弹层 */}
      <OverlaySheet
        open={modeModalOpen}
        onClose={() => setModeModalOpen(false)}
        title={t.modeSheet}
        theme={theme}
      >
        <ScrollView style={{ maxHeight: 380 }} contentContainerStyle={{ gap: 4 }}>
          <Text style={[styles.muted, { paddingHorizontal: 12, paddingBottom: 6 }]}>
            {t.modeSheetHint}
          </Text>
          <Pressable
            accessibilityRole="button"
            style={styles.modalRow}
            onPress={() => {
              setSelectedModeId(null);
              setModeModalOpen(false);
            }}
          >
            <Text style={{ color: theme.colors.foreground, fontSize: 12.5, flex: 1 }}>
              {t.providerDefault}
            </Text>
            {selectedModeId === null ? (
              <Text style={{ color: theme.colors.accent, fontSize: 13 }}>✓</Text>
            ) : null}
          </Pressable>
          {modeCatalog.map((mode) => (
            <Pressable
              key={mode.id}
              accessibilityRole="button"
              style={styles.modalRow}
              onPress={() => {
                setSelectedModeId(mode.id);
                setModeTouched(true);
                setModeModalOpen(false);
              }}
            >
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ color: theme.colors.foreground, fontSize: 12.5 }}>{mode.label}</Text>
                {mode.description ? <Text style={styles.muted}>{mode.description}</Text> : null}
              </View>
              {selectedModeId === mode.id ? (
                <Text style={{ color: theme.colors.accent, fontSize: 13 }}>✓</Text>
              ) : null}
            </Pressable>
          ))}
        </ScrollView>
      </OverlaySheet>

      {/* Feature select 弹层 */}
      <OverlaySheet
        open={featureModalId !== null}
        onClose={() => setFeatureModalId(null)}
        title={featureModal?.label ?? t.providerDefault}
        theme={theme}
      >
        <ScrollView style={{ maxHeight: 360 }} contentContainerStyle={{ gap: 4 }}>
          {featureModal?.description ? (
            <Text style={[styles.muted, { paddingHorizontal: 12, paddingBottom: 6 }]}>
              {featureModal.description}
            </Text>
          ) : null}
          {featureModal?.type === "select"
            ? featureModal.options.map((option) => {
                const current = featureValues[featureModal.id] ?? featureModal.value;
                return (
                  <Pressable
                    key={option.id}
                    accessibilityRole="button"
                    style={styles.modalRow}
                    onPress={() => {
                      setFeaturesTouched(true);
                      setFeatureValues((values) => ({ ...values, [featureModal.id]: option.id }));
                      setFeatureModalId(null);
                    }}
                  >
                    <Text style={{ color: theme.colors.foreground, fontSize: 12.5, flex: 1 }}>
                      {option.label}
                    </Text>
                    {current === option.id ? (
                      <Text style={{ color: theme.colors.accent, fontSize: 13 }}>✓</Text>
                    ) : null}
                  </Pressable>
                );
              })
            : null}
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
