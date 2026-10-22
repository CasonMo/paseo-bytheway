import type { PluginTheme } from "@getpaseo/plugin";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { copyText, Icon, Markdown, TextInput, useToast } from "../host-ui";
import { useT, type UIStrings } from "../i18n";
import type {
  AssistantItem,
  CompactionItem,
  ErrorItem,
  LiveItem,
  NoticeItem,
  PendingPermission,
  ReasoningItem,
  TodoItem,
  ToolItem,
  TurnInfo,
  UserItem,
} from "../live/types";

/* ------------------------------------------------------------------ */
/* 工具函数                                                             */
/* ------------------------------------------------------------------ */

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}m ${rest}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** 流式阶段节流渲染值（默认 180ms）。 */
function useThrottledValue<T>(value: T, ms = 180): T {
  const [throttled, setThrottled] = useState(value);
  const latest = useRef(value);
  latest.current = value;
  useEffect(() => {
    const timer = setInterval(() => {
      setThrottled((current) => (Object.is(current, latest.current) ? current : latest.current));
    }, ms);
    return () => clearInterval(timer);
  }, [ms]);
  return throttled;
}

function StatusDot({ color, size = 8 }: { color: string; size?: number }) {
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />;
}

/* ------------------------------------------------------------------ */
/* assistant / reasoning                                                 */
/* ------------------------------------------------------------------ */

export const AssistantItemView = memo(function AssistantItemView({
  item,
  theme,
  compact,
}: {
  item: AssistantItem;
  theme: PluginTheme;
  compact: boolean;
}) {
  // Paseo 0.13 起宿主不再导出 useRevealedText；流式节流 + 宿主 Markdown
  const throttled = useThrottledValue(item.text);
  return (
    <View style={{ alignSelf: "stretch" }}>
      <Markdown>{throttled}</Markdown>
      {item.phase === "streaming" ? (
        <Text style={{ color: theme.colors.accent, fontSize: 12, marginTop: 2 }}>▍</Text>
      ) : null}
    </View>
  );
});

export const ReasoningItemView = memo(function ReasoningItemView({
  item,
  theme,
  compact,
}: {
  item: ReasoningItem;
  theme: PluginTheme;
  compact: boolean;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const streaming = item.phase === "streaming";
  return (
    <View style={{ borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, overflow: "hidden" }}>
      <Pressable
        accessibilityRole="button"
        onPress={() => setExpanded((value) => !value)}
        style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 8, paddingVertical: 5 }}
      >
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
          {streaming ? t.reasoningRunning : t.reasoning}
        </Text>
        <View style={{ flex: 1 }} />
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>{expanded ? t.collapse : t.expand}</Text>
      </Pressable>
      {expanded ? (
        <View style={{ paddingHorizontal: 8, paddingBottom: 8 }}>
          <Text
            selectable
            style={{
              color: theme.colors.foregroundMuted,
              fontSize: compact ? 11 : 11.5,
              lineHeight: compact ? 16 : 18,
            }}
          >
            {item.text}
          </Text>
        </View>
      ) : null}
    </View>
  );
});

/* ------------------------------------------------------------------ */
/* tool call                                                            */
/* ------------------------------------------------------------------ */

const TOOL_ICON: Record<string, string> = {
  shell: "Terminal",
  read: "Eye",
  edit: "Pencil",
  write: "Pencil",
  search: "Search",
};

function toolTitle(item: ToolItem): string {
  const detail = item.detail ?? {};
  const type = String(detail.type ?? "");
  switch (type) {
    case "shell":
      return String(detail.command ?? item.name);
    case "read":
    case "edit":
    case "write":
      return String(detail.filePath ?? item.name);
    case "search":
      return String(detail.query ?? item.name);
    default:
      return item.name;
  }
}

function statusMeta(status: ToolItem["status"], theme: PluginTheme, t: UIStrings): { label: string; color: string } {
  switch (status) {
    case "running":
      return { label: t.toolRunning, color: theme.colors.accent };
    case "completed":
      return { label: t.toolCompleted, color: theme.colors.statusSuccess };
    case "failed":
      return { label: t.toolFailed, color: theme.colors.statusDanger };
    default:
      return { label: t.toolCanceled, color: theme.colors.foregroundMuted };
  }
}

export const ToolItemView = memo(function ToolItemView({
  item,
  theme,
  compact,
}: {
  item: ToolItem;
  theme: PluginTheme;
  compact: boolean;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const toast = useToast();
  const detail = item.detail ?? {};
  const type = String(detail.type ?? "");
  const status = statusMeta(item.status, theme, t);

  const body = useMemo(() => {
    const lines: Array<{ text: string; color?: string }> = [];
    if (type === "shell") {
      if (typeof detail.output === "string" && detail.output.length > 0) {
        for (const line of detail.output.split("\n")) lines.push({ text: line });
      }
    } else if (type === "edit" && typeof detail.unifiedDiff === "string") {
      for (const line of detail.unifiedDiff.split("\n")) {
        const color = line.startsWith("+") && !line.startsWith("+++")
          ? theme.colors.statusSuccess
          : line.startsWith("-") && !line.startsWith("---")
            ? theme.colors.statusDanger
            : undefined;
        lines.push({ text: line, color });
      }
    } else if ((type === "read" || type === "write") && typeof detail.content === "string") {
      for (const line of detail.content.split("\n")) lines.push({ text: line });
    } else if (type === "search" && typeof detail.content === "string") {
      for (const line of detail.content.split("\n")) lines.push({ text: line });
    }
    return lines;
  }, [detail, type, theme]);


  const copyPayload = () => {
    void (async () => {
      const text =
        type === "shell"
          ? String(detail.command ?? "")
          : type === "edit"
            ? String(detail.unifiedDiff ?? "")
            : String(detail.content ?? toolTitle(item));
      try {
        await copyText(text);
        toast.show(t.copied, { variant: "success" });
      } catch {
        toast.error(t.copyFailed);
      }
    })();
  };

  return (
    <View style={{ borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, overflow: "hidden" }}>
      <Pressable
        accessibilityRole="button"
        onPress={() => setExpanded((value) => !value)}
        style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 8, paddingVertical: 6 }}
      >
        <Icon name={TOOL_ICON[type] ?? "Wrench"} size={13} color={theme.colors.foregroundMuted} />
        <Text
          numberOfLines={1}
          style={{ color: theme.colors.foreground, fontSize: compact ? 11.5 : 12, fontFamily: "Menlo", flex: 1 }}
        >
          {toolTitle(item)}
        </Text>
        {item.status === "running" ? <StatusDot color={status.color} size={6} /> : null}
        <Text style={{ color: status.color, fontSize: 10 }}>{status.label}</Text>
        {body.length > 0 || item.error != null ? (
          <Icon
            name={expanded ? "ChevronDown" : "ChevronRight"}
            size={12}
            color={theme.colors.foregroundMuted}
          />
        ) : null}
      </Pressable>

      {expanded && body.length > 0 ? (
        <View style={{ paddingHorizontal: 8, paddingBottom: 6 }}>
          {body.map((line, index) => (
            <Text
              key={index}
              selectable
              numberOfLines={1}
              style={{
                fontFamily: "Menlo",
                fontSize: compact ? 10.5 : 11,
                lineHeight: compact ? 15 : 16,
                color: line.color ?? theme.colors.foregroundMuted,
              }}
            >
              {line.text || " "}
            </Text>
          ))}
          <View style={{ flexDirection: "row", gap: 12, marginTop: 4 }}>
            <Pressable accessibilityRole="button" onPress={() => setExpanded(false)} hitSlop={6}>
              <Text style={{ color: theme.colors.accent, fontSize: 10.5 }}>{t.collapse}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={copyPayload} hitSlop={6}>
              <Text style={{ color: theme.colors.accent, fontSize: 10.5 }}>{t.copy}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {expanded && item.error != null ? (
        <View style={{ paddingHorizontal: 8, paddingBottom: 6 }}>
          <Text selectable style={{ color: theme.colors.statusDanger, fontSize: 11 }}>
            {typeof item.error === "string" ? item.error : JSON.stringify(item.error)}
          </Text>
        </View>
      ) : null}
    </View>
  );
});

/* ------------------------------------------------------------------ */
/* todo / user / notice / error / compaction                            */
/* ------------------------------------------------------------------ */

export const TodoItemView = memo(function TodoItemView({
  item,
  theme,
  compact,
}: {
  item: TodoItem;
  theme: PluginTheme;
  compact: boolean;
}) {
  return (
    <View style={{ borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, padding: 8, gap: 3 }}>
      {item.items.map((entry, index) => {
        const done = entry.status === "completed" || entry.completed === true;
        const active = entry.status === "in_progress";
        return (
          <View key={entry.id ?? index} style={{ flexDirection: "row", gap: 6 }}>
            <Text style={{ color: done ? theme.colors.statusSuccess : theme.colors.foregroundMuted, fontSize: compact ? 11 : 12 }}>
              {done ? "✓" : active ? "◐" : "○"}
            </Text>
            <Text
              style={{
                color: done ? theme.colors.foregroundMuted : theme.colors.foreground,
                fontSize: compact ? 11.5 : 12,
                textDecorationLine: done ? "line-through" : "none",
                flex: 1,
              }}
            >
              {entry.text}
            </Text>
          </View>
        );
      })}
    </View>
  );
});

export const UserItemView = memo(function UserItemView({
  item,
  theme,
  compact,
}: {
  item: UserItem;
  theme: PluginTheme;
  compact: boolean;
}) {
  return (
    <View style={{ alignSelf: "flex-end", maxWidth: "86%" }}>
      <View
        style={{
          backgroundColor: theme.colors.surface2,
          borderRadius: 12,
          paddingHorizontal: 10,
          paddingVertical: 7,
        }}
      >
        <Text selectable style={{ color: theme.colors.foreground, fontSize: compact ? 12 : 13, lineHeight: compact ? 18 : 20 }}>
          {item.text}
        </Text>
      </View>
    </View>
  );
});

export const NoticeItemView = memo(function NoticeItemView({
  item,
  theme,
  compact,
}: {
  item: NoticeItem;
  theme: PluginTheme;
  compact: boolean;
}) {
  const color =
    item.level === "error"
      ? theme.colors.statusDanger
      : item.level === "warning"
        ? theme.colors.statusWarning
        : theme.colors.foregroundMuted;
  return (
    <View style={{ flexDirection: "row", gap: 6, alignItems: "flex-start" }}>
      <Text style={{ color, fontSize: compact ? 11 : 12 }}>•</Text>
      <Text selectable style={{ color, fontSize: compact ? 11.5 : 12, lineHeight: compact ? 17 : 18, flex: 1 }}>
        {item.message}
      </Text>
    </View>
  );
});

export const ErrorItemView = memo(function ErrorItemView({
  item,
  theme,
  compact,
}: {
  item: ErrorItem;
  theme: PluginTheme;
  compact: boolean;
}) {
  return (
    <View
      style={{
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.statusDanger,
        padding: 8,
        backgroundColor: theme.colors.surface0,
      }}
    >
      <Text selectable style={{ color: theme.colors.statusDanger, fontSize: compact ? 11.5 : 12, lineHeight: compact ? 17 : 18 }}>
        {item.message}
      </Text>
    </View>
  );
});

export const CompactionItemView = memo(function CompactionItemView({
  item,
  theme,
  compact,
}: {
  item: CompactionItem;
  theme: PluginTheme;
  compact: boolean;
}) {
  const t = useT();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <View style={{ flex: 1, height: 1, backgroundColor: theme.colors.border }} />
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: compact ? 10 : 10.5 }}>
        {item.status === "loading" ? t.compactionLoading : t.compactionDone}
      </Text>
      <View style={{ flex: 1, height: 1, backgroundColor: theme.colors.border }} />
    </View>
  );
});

/* ------------------------------------------------------------------ */
/* turn 状态行                                                          */
/* ------------------------------------------------------------------ */

export function TurnStatusLine({
  turn,
  agentRunning,
  theme,
  compact,
}: {
  turn: TurnInfo;
  agentRunning?: boolean;
  theme: PluginTheme;
  compact: boolean;
}) {
  const t = useT();
  const running = turn.status === "running" || (Boolean(agentRunning) && turn.status === "idle");
  const now = useNow(running);
  if (!running && turn.status === "idle") return null;

  const started = turn.startedAt ?? now;
  const elapsed = (turn.finishedAt ?? now) - started;
  const usage = turn.usage;
  const parts: string[] = [];
  if (turn.status === "completed") {
    parts.push(`${t.timePrefix} ${formatDuration(elapsed)}`);
    if (usage?.outputTokens != null) parts.push(`↓${usage.inputTokens ?? 0} ↑${usage.outputTokens}`);
    if (usage?.totalCostUsd != null) parts.push(`$${usage.totalCostUsd.toFixed(4)}`);
    if (usage?.contextWindowUsedTokens != null && usage?.contextWindowMaxTokens) {
      parts.push(`ctx ${Math.round((usage.contextWindowUsedTokens / usage.contextWindowMaxTokens) * 100)}%`);
    }
  }

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      {running ? <StatusDot color={theme.colors.accent} size={6} /> : null}
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: compact ? 10.5 : 11 }}>
        {running
          ? turn.status === "running" && turn.startedAt
            ? t.answeringElapsed(formatDuration(elapsed))
            : t.answering
          : turn.status === "completed"
            ? parts.join(" · ")
            : turn.status === "failed"
              ? t.failedPrefix(turn.error ?? "")
              : t.canceled}
      </Text>
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* 权限横幅                                                             */
/* ------------------------------------------------------------------ */

type PermissionRespond = (response: {
  behavior: "allow" | "deny";
  selectedActionId?: string;
  updatedInput?: Record<string, unknown>;
}) => void;

interface QuestionLike {
  question: string;
  header: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
  allowOther?: boolean;
}

function readQuestions(input: unknown): QuestionLike[] {
  if (!input || typeof input !== "object") return [];
  const list = (input as { questions?: unknown }).questions;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (entry): entry is QuestionLike =>
      !!entry &&
      typeof entry === "object" &&
      typeof (entry as QuestionLike).question === "string" &&
      typeof (entry as QuestionLike).header === "string",
  );
}

/** OpenCode question 类请求：渲染为问题选项面板，提交 answers 而非简单 allow。 */
function QuestionForm({
  permission,
  theme,
  compact,
  responding,
  onRespond,
}: {
  permission: PendingPermission;
  theme: PluginTheme;
  compact: boolean;
  responding: boolean;
  onRespond: PermissionRespond;
}) {
  const t = useT();
  const questions = useMemo(
    () => readQuestions(permission.request.input),
    [permission.request.input],
  );
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [others, setOthers] = useState<Record<string, string>>({});
  const [step, setStep] = useState(0);

  const total = questions.length;
  const index = Math.min(step, Math.max(total - 1, 0));
  const q = questions[index];
  const isLast = index >= total - 1;

  /** 单选点选后自动进入下一题；多选/「其他」输入后手动下一步。 */
  const pick = (question: QuestionLike, label: string) => {
    setSelected((prev) => {
      const current = prev[question.header] ?? [];
      if (question.multiSelect) {
        return {
          ...prev,
          [question.header]: current.includes(label)
            ? current.filter((value) => value !== label)
            : [...current, label],
        };
      }
      return { ...prev, [question.header]: [label] };
    });
    if (!question.multiSelect && !isLast && !responding) {
      setStep(index + 1);
    }
  };

  const hasValue = questions.some(
    (question) =>
      (selected[question.header]?.length ?? 0) > 0 ||
      (others[question.header] ?? "").trim().length > 0,
  );

  const submit = () => {
    const answers: Record<string, string> = {};
    for (const question of questions) {
      const values = [...(selected[question.header] ?? [])];
      const other = (others[question.header] ?? "").trim();
      if (other) values.push(other);
      answers[question.header] = values.join(",");
    }
    onRespond({ behavior: "allow", updatedInput: { answers } });
  };

  if (!q) return null;

  const navButton = (label: string, onPress: () => void, primary: boolean, disabled: boolean) => (
    <Pressable
      key={label}
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={{
        borderRadius: 7,
        borderWidth: 1,
        borderColor: primary ? theme.colors.accent : theme.colors.border,
        backgroundColor: primary ? theme.colors.accent : "transparent",
        paddingHorizontal: 12,
        paddingVertical: 5,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Text
        style={{
          color: primary ? theme.colors.accentForeground : theme.colors.foreground,
          fontSize: 11.5,
          fontWeight: "600",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );

  return (
    <View
      style={{
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        paddingHorizontal: compact ? 10 : 12,
        paddingVertical: 8,
        gap: 8,
      }}
    >
      {total > 1 ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
          {index + 1} / {total}
        </Text>
      ) : null}
      <View style={{ gap: 6 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: compact ? 12 : 12.5 }}>
          {q.question}
        </Text>
        {(q.options ?? []).map((option) => {
          const checked = (selected[q.header] ?? []).includes(option.label);
          return (
            <Pressable
              key={option.label}
              accessibilityRole="button"
              disabled={responding}
              onPress={() => pick(q, option.label)}
              style={{
                flexDirection: "row",
                alignItems: "flex-start",
                gap: 8,
                paddingVertical: 3,
                opacity: responding ? 0.5 : 1,
              }}
            >
              <View
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: q.multiSelect ? 3 : 7,
                  borderWidth: 1.5,
                  borderColor: checked ? theme.colors.accent : theme.colors.foregroundMuted,
                  backgroundColor: checked ? theme.colors.accent : "transparent",
                  marginTop: 2,
                }}
              />
              <View style={{ flex: 1, gap: 1 }}>
                <Text style={{ color: theme.colors.foreground, fontSize: compact ? 11.5 : 12 }}>
                  {option.label}
                </Text>
                {option.description ? (
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                    {option.description}
                  </Text>
                ) : null}
              </View>
            </Pressable>
          );
        })}
        {q.allowOther ? (
          <TextInput
            style={{
              borderRadius: 7,
              borderWidth: 1,
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surface2 ?? theme.colors.surface1,
              color: theme.colors.foreground,
              paddingHorizontal: 8,
              paddingVertical: 5,
              fontSize: 11.5,
            }}
            placeholder={t.questionOther}
            placeholderTextColor={theme.colors.foregroundMuted}
            editable={!responding}
            value={others[q.header] ?? ""}
            onChangeText={(value) => setOthers((prev) => ({ ...prev, [q.header]: value }))}
          />
        ) : null}
      </View>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        {index > 0 ? navButton(t.questionPrev, () => setStep(index - 1), false, responding) : null}
        {!isLast ? navButton(t.questionNext, () => setStep(index + 1), false, responding) : null}
        {isLast ? navButton(t.questionSubmit, submit, true, responding || !hasValue) : null}
        <View style={{ flex: 1 }} />
        <Pressable
          accessibilityRole="button"
          disabled={responding}
          onPress={() => onRespond({ behavior: "deny" })}
          style={{
            borderRadius: 7,
            borderWidth: 1,
            borderColor: theme.colors.statusDanger,
            paddingHorizontal: 12,
            paddingVertical: 5,
            opacity: responding ? 0.5 : 1,
          }}
        >
          <Text style={{ color: theme.colors.statusDanger, fontSize: 11.5, fontWeight: "600" }}>
            {t.questionClose}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

export function PermissionBanner({
  permission,
  theme,
  compact,
  responding,
  onRespond,
}: {
  permission: PendingPermission;
  theme: PluginTheme;
  compact: boolean;
  responding: boolean;
  onRespond: PermissionRespond;
}) {
  const t = useT();
  const request = permission.request;

  if (request.kind === "question" && readQuestions(request.input).length > 0) {
    return (
      <QuestionForm
        permission={permission}
        theme={theme}
        compact={compact}
        responding={responding}
        onRespond={onRespond}
      />
    );
  }

  const detail = request.detail ?? {};
  const detailType = String((detail as { type?: unknown }).type ?? "");
  const detailLine =
    detailType === "shell"
      ? `$ ${String((detail as { command?: unknown }).command ?? "")}`
      : detailType === "read" || detailType === "edit" || detailType === "write"
        ? String((detail as { filePath?: unknown }).filePath ?? "")
        : "";

  const actions = request.actions ?? [];
  const buttons =
    actions.length > 0
      ? actions.map((action) => ({
          key: action.id,
          label: action.label,
          behavior: action.behavior,
          danger: action.variant === "danger" || action.behavior === "deny",
          selectedActionId: action.id,
        }))
      : [
          { key: "allow", label: t.allow, behavior: "allow" as const, danger: false, selectedActionId: undefined },
          { key: "deny", label: t.deny, behavior: "deny" as const, danger: true, selectedActionId: undefined },
        ];

  return (
    <View
      style={{
        borderTopWidth: 1,
        borderTopColor: theme.colors.statusWarning,
        backgroundColor: theme.colors.surface1,
        paddingHorizontal: compact ? 10 : 12,
        paddingVertical: 8,
        gap: 6,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Text style={{ color: theme.colors.statusWarning, fontSize: 12, fontWeight: "600" }}>
          {t.permissionTitle}
        </Text>
        <View style={{ flex: 1 }} />
        {responding ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{t.processing}</Text>
        ) : null}
      </View>
      <Text style={{ color: theme.colors.foreground, fontSize: compact ? 11.5 : 12 }}>
        {request.title ?? request.description ?? request.name ?? t.toolRequest}
      </Text>
      {detailLine ? (
        <Text
          selectable
          numberOfLines={3}
          style={{ fontFamily: "Menlo", color: theme.colors.foregroundMuted, fontSize: compact ? 10.5 : 11 }}
        >
          {detailLine}
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", gap: 8 }}>
        {buttons.map((button) => (
          <Pressable
            key={button.key}
            accessibilityRole="button"
            disabled={responding}
            onPress={() =>
              onRespond({ behavior: button.behavior, selectedActionId: button.selectedActionId })
            }
            style={{
              borderRadius: 7,
              borderWidth: 1,
              borderColor: button.danger ? theme.colors.statusDanger : theme.colors.accent,
              backgroundColor: button.danger ? "transparent" : theme.colors.accent,
              paddingHorizontal: 12,
              paddingVertical: 5,
              opacity: responding ? 0.5 : 1,
            }}
          >
            <Text
              style={{
                color: button.danger ? theme.colors.statusDanger : theme.colors.accentForeground,
                fontSize: 11.5,
                fontWeight: "600",
              }}
            >
              {button.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* 统一分发                                                             */
/* ------------------------------------------------------------------ */

export function LiveItemView({
  item,
  theme,
  compact,
}: {
  item: LiveItem;
  theme: PluginTheme;
  compact: boolean;
}) {
  switch (item.kind) {
    case "assistant":
      return <AssistantItemView item={item} theme={theme} compact={compact} />;
    case "reasoning":
      return <ReasoningItemView item={item} theme={theme} compact={compact} />;
    case "tool":
      return <ToolItemView item={item} theme={theme} compact={compact} />;
    case "todo":
      return <TodoItemView item={item} theme={theme} compact={compact} />;
    case "user":
      return <UserItemView item={item} theme={theme} compact={compact} />;
    case "notice":
      return <NoticeItemView item={item} theme={theme} compact={compact} />;
    case "error":
      return <ErrorItemView item={item} theme={theme} compact={compact} />;
    case "compaction":
      return <CompactionItemView item={item} theme={theme} compact={compact} />;
    default:
      return null;
  }
}
