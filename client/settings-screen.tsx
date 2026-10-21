import { type PluginSurfaceProps, useSettings } from "@getpaseo/plugin/client";
import {
  SettingsInput,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { resolveLang, settingsTr } from "./i18n";
import { applyUiLanguage } from "./ui-registration";
import { sidekickSettings, type SidekickSettings } from "../shared/settings";

type FieldKey = keyof SidekickSettings;

const intRanges: Partial<Record<FieldKey, { min: number; max: number }>> = {
  snapshotDepth: { min: 0, max: 50 },
  permissionTimeoutReadMin: { min: 0, max: 1440 },
  permissionTimeoutWriteMin: { min: 0, max: 1440 },
  maxConcurrentAsk: { min: 1, max: 8 },
  maxConcurrentWork: { min: 1, max: 8 },
  maxConcurrentTotal: { min: 1, max: 16 },
};

export function SidekickSettingsScreen({ theme, layout }: PluginSurfaceProps) {
  const settings = useSettings(sidekickSettings);
  const ready = settings.status === "ready";
  const values = settings.status === "ready" ? settings.values : null;
  const valuesRef = useRef<SidekickSettings | null>(null);
  if (values) valuesRef.current = values;

  const lang = resolveLang(values?.language);
  const tr = (zhText: string) => settingsTr(lang, zhText);

  useEffect(() => {
    applyUiLanguage(lang);
  }, [lang]);

  const [saveError, setSaveError] = useState<string | null>(null);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const timer of map.values()) clearTimeout(timer);
      map.clear();
    };
  }, []);

  const save = (patch: Partial<SidekickSettings>) => {
    const current = valuesRef.current;
    if (!ready || !current) return;
    void settings
      .save({ ...current, ...patch } as SidekickSettings, settings.revision)
      .then(() => setSaveError(null))
      .catch((error) => setSaveError(error instanceof Error ? error.message : String(error)));
  };

  const saveDebounced = (key: FieldKey, value: unknown, delay = 600) => {
    const existing = timers.current.get(key);
    if (existing) clearTimeout(existing);
    timers.current.set(
      key,
      setTimeout(() => {
        timers.current.delete(key);
        save({ [key]: value } as Partial<SidekickSettings>);
      }, delay),
    );
  };

  const saveInt = (key: FieldKey, raw: string) => {
    const range = intRanges[key];
    const parsed = Number.parseInt(raw.trim(), 10);
    if (Number.isNaN(parsed)) return;
    const clamped = range ? Math.min(range.max, Math.max(range.min, parsed)) : parsed;
    saveDebounced(key, clamped);
  };

  const saveText = (key: FieldKey, raw: string) => {
    saveDebounced(key, raw);
  };

  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        backgroundColor: theme.colors.surface0,
        padding: layout.compact ? 12 : 20,
        gap: 12,
      },
      error: { color: theme.colors.statusDanger, fontSize: layout.compact ? 12 : 13 },
      hint: { color: theme.colors.foregroundMuted, fontSize: layout.compact ? 11 : 12 },
    }),
    [theme, layout.compact],
  );

  if (!ready || !values) {
    return (
      <View style={styles.screen}>
        <Text style={styles.hint}>
          {settings.status === "invalid"
            ? `${tr("设置数据无效：")}${settings.error}`
            : tr("加载设置中…")}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      {saveError ? <Text style={styles.error}>{`${tr("保存失败：")}${saveError}`}</Text> : null}

      <SettingsSection title={tr("基本")}>
        <SettingsSelect
          label={tr("界面语言")}
          value={values.language}
          options={[
            { label: tr("自动"), value: "auto" },
            { label: tr("中文"), value: "zh" },
            { label: "English", value: "en" },
          ]}
          onValueChange={(value) => save({ language: value })}
        />
      </SettingsSection>

      <SettingsSection title={tr("新线程默认")} info={tr("影响 /btw、/side 新开线程时的默认选择。")}>
        <SettingsSelect
          label={tr("默认模式")}
          value={values.defaultMode}
          options={[
            { label: tr("Chat（只读建议）"), value: "ask" },
            { label: tr("Build（可执行任务）"), value: "work" },
          ]}
          onValueChange={(value) => save({ defaultMode: value })}
        />
        <SettingsInput
          label={tr("默认模型")}
          hint={tr("follow = 跟随主会话；或填写 provider/model（如 codex/gpt-5.5）")}
          initialValue={values.defaultModel}
          onChangeText={(text) => saveText("defaultModel", text)}
        />
      </SettingsSection>

      <SettingsSection
        title={tr("上下文")}
        info={tr("侧聊如何了解主会话。默认「id 直连」：侧聊通过 Paseo 工具按需读取主会话最新进展。")}
      >
        <SettingsSelect
          label={tr("首轮快照深度")}
          value={String(values.snapshotDepth)}
          options={[
            { label: tr("关闭（纯直连）"), value: "0" },
            { label: tr("最近 6 条"), value: "6" },
            { label: tr("最近 12 条"), value: "12" },
            { label: tr("最近 30 条"), value: "30" },
          ]}
          onValueChange={(value) => save({ snapshotDepth: Number.parseInt(value, 10) })}
        />
        <SettingsSwitch
          label={tr("动作摘要")}
          hint={tr("快照中附带最近工具动作摘要（变更类优先）")}
          value={values.includeActionDigest}
          onValueChange={(value) => save({ includeActionDigest: value })}
        />
        <SettingsSelect
          label={tr("兜底模式")}
          value={values.contextFallback}
          options={[
            { label: tr("自动（工具不可用时被动同步）"), value: "auto" },
            { label: tr("关闭"), value: "off" },
          ]}
          onValueChange={(value) => save({ contextFallback: value })}
        />
      </SettingsSection>

      <SettingsSection title={tr("线程")}>
        <SettingsSwitch
          label={tr("挂到主会话")}
          hint={tr("侧聊 agent 作为主会话的子 agent（便于归档联动与查找）")}
          value={values.attachToMain}
          onValueChange={(value) => save({ attachToMain: value })}
        />
        <SettingsSwitch
          label={tr("AI 生成线程标题")}
          hint={tr("创建后用 AI 生成简短标题（手动改过的标题不会被覆盖）")}
          value={values.aiTitles}
          onValueChange={(value) => save({ aiTitles: value })}
        />
        <SettingsInput
          label={tr("标题生成模型")}
          hint={tr("follow = 使用线程同款模型；或填写 provider/model（如 codex/gpt-5.5）")}
          initialValue={values.titleModel}
          onChangeText={(text) => saveText("titleModel", text)}
        />
      </SettingsSection>

      <SettingsSection title={tr("权限")}>
        <SettingsSelect
          label={tr("权限策略")}
          value={values.permissionPolicy}
          options={[
            { label: tr("询问（默认）"), value: "ask" },
            { label: tr("自动放行只读类"), value: "allow-readonly" },
            { label: tr("全部拒绝"), value: "deny-all" },
          ]}
          onValueChange={(value) => save({ permissionPolicy: value })}
        />
        <SettingsInput
          label={tr("只读类超时自动拒绝（分钟）")}
          hint={tr("0 = 不超时")}
          initialValue={String(values.permissionTimeoutReadMin)}
          onChangeText={(text) => saveInt("permissionTimeoutReadMin", text)}
        />
        <SettingsInput
          label={tr("写类超时自动拒绝（分钟）")}
          hint={tr("0 = 不超时")}
          initialValue={String(values.permissionTimeoutWriteMin)}
          onChangeText={(text) => saveInt("permissionTimeoutWriteMin", text)}
        />
      </SettingsSection>

      <SettingsSection title={tr("并发与停止")}>
        <SettingsInput
          label={tr("Chat 并发上限")}
          initialValue={String(values.maxConcurrentAsk)}
          onChangeText={(text) => saveInt("maxConcurrentAsk", text)}
        />
        <SettingsInput
          label={tr("Build 并发上限")}
          initialValue={String(values.maxConcurrentWork)}
          onChangeText={(text) => saveInt("maxConcurrentWork", text)}
        />
        <SettingsInput
          label={tr("总并发上限")}
          initialValue={String(values.maxConcurrentTotal)}
          onChangeText={(text) => saveInt("maxConcurrentTotal", text)}
        />
        <SettingsSwitch
          label={tr("实验性取消")}
          hint={tr("停止时先尝试 MCP 辅助取消，5 秒未生效自动降级「打开标签页停止」")}
          value={values.experimentalCancel}
          onValueChange={(value) => save({ experimentalCancel: value })}
        />
      </SettingsSection>

      <SettingsSection title={tr("关于")}>
        <Text style={styles.hint}>ByTheWay 侧聊（paseo-bytheway v0.1.0）</Text>
        <Text style={styles.hint}>
          {tr("不打断主会话的旁路侧聊：实时执行流、多线程、agent 直连上下文。RPC 直连 daemon，转录不落盘。")}
        </Text>
      </SettingsSection>
    </View>
  );
}
