import type { PluginTheme } from "@getpaseo/plugin";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon, ScrollView, useToast } from "../host-ui";
import { useT, type UIStrings } from "../i18n";
import type { SubagentBucket, SubagentRow, SubagentSummary } from "./model";

export interface SubagentPillProps {
  agentId: string;
  rows: SubagentRow[];
  summary: SubagentSummary;
  finishedCount: number;
  theme: PluginTheme;
  compact: boolean;
  onOpenRow: (row: SubagentRow) => void;
  onArchivePaseo: (agentId: string) => Promise<void>;
  onDetachPaseo: (agentId: string) => Promise<void>;
  onArchiveFinished: () => Promise<unknown>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pillLabel(summary: SubagentSummary, t: UIStrings): string {
  const total = summary.total === 1 ? t.subagentsPillOne : t.subagentsPillMany(summary.total);
  const details: string[] = [];
  if (summary.running > 0) {
    details.push(t.subagentsPillRunning(summary.running));
  }
  if (summary.failed > 0) {
    details.push(t.subagentsPillFailed(summary.failed));
  }
  if (summary.needsInput > 0) {
    details.push(t.subagentsPillNeedsInput(summary.needsInput));
  }
  if (summary.attention > 0) {
    details.push(t.subagentsPillAttention(summary.attention));
  }
  return [total, ...details.slice(0, 2)].join(" · ");
}

function bucketColor(bucket: SubagentBucket, theme: PluginTheme): string {
  switch (bucket) {
    case "running":
      return theme.colors.accent;
    case "failed":
      return theme.colors.statusDanger;
    case "needs_input":
    case "attention":
      return theme.colors.statusWarning;
    default:
      return theme.colors.foregroundMuted;
  }
}

function statusLabel(row: SubagentRow, t: UIStrings): string {
  switch (row.bucket) {
    case "running":
      return t.toolRunning;
    case "failed":
      return t.toolFailed;
    case "needs_input":
      return t.subagentsStatusNeedsInput;
    case "attention":
      return t.subagentsStatusAttention;
    default:
      if (row.rawStatus === "canceled") return t.canceled;
      if (row.rawStatus === "idle") return t.statusIdle;
      if (row.rawStatus === "closed") return t.statusStopped;
      return t.toolCompleted;
  }
}

export function SubagentPill({
  agentId,
  rows,
  summary,
  finishedCount,
  theme,
  compact,
  onOpenRow,
  onArchivePaseo,
  onDetachPaseo,
  onArchiveFinished,
}: SubagentPillProps) {
  const t = useT();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [confirmArchiveId, setConfirmArchiveId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [archivingFinished, setArchivingFinished] = useState(false);
  const label = useMemo(() => pillLabel(summary, t), [summary, t]);

  useEffect(() => {
    setOpen(false);
    setConfirmArchiveId(null);
    setBusyId(null);
  }, [agentId]);

  useEffect(() => {
    if (rows.length === 0) {
      setOpen(false);
      setConfirmArchiveId(null);
    }
  }, [rows.length]);

  if (rows.length === 0) return null;

  const confirmRow = confirmArchiveId
    ? rows.find((row) => row.id === confirmArchiveId && row.kind === "paseo") ?? null
    : null;

  const archivePaseo = async (row: SubagentRow) => {
    setBusyId(row.id);
    try {
      await onArchivePaseo(row.id);
      setConfirmArchiveId(null);
      toast.show(t.subagentsArchivedToast, { variant: "success" });
    } catch (error) {
      toast.error(t.subagentsActionFailed(messageOf(error)));
    } finally {
      setBusyId(null);
    }
  };

  const requestArchive = (row: SubagentRow) => {
    if (row.bucket === "running" || row.bucket === "needs_input") {
      setConfirmArchiveId(row.id);
      return;
    }
    void archivePaseo(row);
  };

  const detach = async (row: SubagentRow) => {
    setBusyId(row.id);
    try {
      await onDetachPaseo(row.id);
      toast.show(t.subagentsDetachedToast, { variant: "success" });
    } catch (error) {
      toast.error(t.subagentsActionFailed(messageOf(error)));
    } finally {
      setBusyId(null);
    }
  };

  const archiveFinished = async () => {
    setArchivingFinished(true);
    try {
      await onArchiveFinished();
      toast.show(t.subagentsArchiveFinishedToast, { variant: "success" });
    } catch (error) {
      toast.error(t.subagentsActionFailed(messageOf(error)));
    } finally {
      setArchivingFinished(false);
    }
  };

  return (
    <View style={{ position: "relative", zIndex: open ? 80 : 1 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ expanded: open }}
        onPress={() => {
          setOpen((value) => !value);
          setConfirmArchiveId(null);
        }}
        style={{
          alignSelf: "flex-start",
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          borderWidth: 1,
          borderColor: open ? theme.colors.accent : theme.colors.border,
          backgroundColor: open ? theme.colors.surface2 : theme.colors.surface1,
          borderRadius: 999,
          paddingHorizontal: 10,
          paddingVertical: 4,
        }}
      >
        {summary.running > 0 ? (
          <View
            style={{
              width: 7,
              height: 7,
              borderRadius: 4,
              backgroundColor: theme.colors.accent,
            }}
          />
        ) : null}
        <Text
          numberOfLines={1}
          style={{
            color: open ? theme.colors.foreground : theme.colors.foregroundMuted,
            fontSize: compact ? 10.5 : 11,
          }}
        >
          {label}
        </Text>
        <Icon
          name={open ? "ChevronDown" : "ChevronUp"}
          size={11}
          color={theme.colors.foregroundMuted}
        />
      </Pressable>

      {open ? (
        <View
          style={{
            position: "absolute",
            left: 0,
            bottom: "100%",
            marginBottom: 8,
            width: compact ? "100%" : 360,
            maxWidth: "100%",
            zIndex: 90,
            elevation: 8,
            borderWidth: 1,
            borderColor: theme.colors.border,
            borderRadius: 10,
            backgroundColor: theme.colors.surface1,
            padding: 5,
            shadowColor: "#000",
            shadowOpacity: 0.18,
            shadowRadius: 12,
            shadowOffset: { width: 0, height: 4 },
          }}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              paddingHorizontal: 7,
              paddingVertical: 5,
            }}
          >
            <Text style={{ color: theme.colors.foreground, fontSize: 11.5, fontWeight: "600", flex: 1 }}>
              {t.subagentsTitle}
            </Text>
            <Pressable accessibilityRole="button" accessibilityLabel={t.close} onPress={() => setOpen(false)}>
              <Icon name="X" size={12} color={theme.colors.foregroundMuted} />
            </Pressable>
          </View>

          {finishedCount > 0 ? (
            <Pressable
              accessibilityRole="button"
              disabled={archivingFinished}
              onPress={() => void archiveFinished()}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 7,
                borderRadius: 7,
                paddingHorizontal: 7,
                paddingVertical: 7,
                backgroundColor: theme.colors.surface2,
                opacity: archivingFinished ? 0.6 : 1,
              }}
            >
              <Icon name="Archive" size={13} color={theme.colors.foregroundMuted} />
              <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 11.5, flex: 1 }}>
                {archivingFinished ? t.subagentsArchiveFinishedBusy : t.subagentsArchiveFinished}
              </Text>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
                {finishedCount}
              </Text>
            </Pressable>
          ) : null}

          {confirmRow ? (
            <View
              style={{
                gap: 7,
                borderTopWidth: finishedCount > 0 ? 1 : 0,
                borderTopColor: theme.colors.border,
                marginTop: finishedCount > 0 ? 5 : 0,
                paddingHorizontal: 7,
                paddingVertical: 7,
                backgroundColor: theme.colors.surface2,
                borderRadius: 7,
              }}
            >
              <Text style={{ color: theme.colors.foreground, fontSize: 11.5, lineHeight: 16 }}>
                {t.subagentsArchiveRunningConfirm}
              </Text>
              <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 12 }}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setConfirmArchiveId(null)}
                  disabled={busyId === confirmRow.id}
                >
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{t.cancel}</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void archivePaseo(confirmRow)}
                  disabled={busyId === confirmRow.id}
                >
                  <Text style={{ color: theme.colors.statusDanger, fontSize: 11, fontWeight: "600" }}>
                    {t.subagentsArchive}
                  </Text>
                </Pressable>
              </View>
            </View>
          ) : null}

          <View
            style={{
              height: finishedCount > 0 || confirmRow ? 1 : 0,
              backgroundColor: theme.colors.border,
              marginVertical: finishedCount > 0 || confirmRow ? 4 : 0,
            }}
          />

          <ScrollView
            style={{ maxHeight: compact ? 230 : 280 }}
            contentContainerStyle={{ gap: 2 }}
            keyboardShouldPersistTaps="handled"
          >
            {rows.map((row) => {
              const busy = busyId === row.id;
              const actionsDisabled = busyId !== null || archivingFinished;
              const color = bucketColor(row.bucket, theme);
              return (
                <View
                  key={row.key}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 4,
                    borderRadius: 7,
                    paddingLeft: 7,
                    paddingRight: row.kind === "paseo" ? 4 : 7,
                    paddingVertical: 6,
                    opacity: busy ? 0.55 : 1,
                  }}
                >
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${row.title} · ${statusLabel(row, t)}`}
                    onPress={() => {
                      setOpen(false);
                      onOpenRow(row);
                    }}
                    style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 7 }}
                  >
                    <View style={{ width: 8, alignItems: "center" }}>
                      <View
                        style={{
                          width: row.bucket === "running" ? 7 : 6,
                          height: row.bucket === "running" ? 7 : 6,
                          borderRadius: 4,
                          backgroundColor: color,
                        }}
                      />
                    </View>
                    <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
                      <Text
                        numberOfLines={1}
                        style={{ color: theme.colors.foreground, fontSize: compact ? 11.5 : 12 }}
                      >
                        {row.title}
                      </Text>
                      {row.subtitle ? (
                        <Text
                          numberOfLines={1}
                          style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}
                        >
                          {row.subtitle}
                        </Text>
                      ) : null}
                    </View>
                    <Text style={{ color, fontSize: 9.5 }}>{statusLabel(row, t)}</Text>
                  </Pressable>

                  {row.kind === "paseo" ? (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`${t.subagentsDetach} ${row.title}`}
                        disabled={actionsDisabled}
                        hitSlop={4}
                        onPress={() => void detach(row)}
                        style={{ padding: 4 }}
                      >
                        <Icon name="Unlink" size={12} color={theme.colors.foregroundMuted} />
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`${t.subagentsArchive} ${row.title}`}
                        disabled={actionsDisabled}
                        hitSlop={4}
                        onPress={() => requestArchive(row)}
                        style={{ padding: 4 }}
                      >
                        <Icon name="Archive" size={12} color={theme.colors.foregroundMuted} />
                      </Pressable>
                    </View>
                  ) : (
                    <Icon name="ChevronRight" size={12} color={theme.colors.foregroundMuted} />
                  )}
                </View>
              );
            })}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}
