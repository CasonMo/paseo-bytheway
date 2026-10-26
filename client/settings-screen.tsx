import { type PluginSurfaceProps, useSettings } from "@getpaseo/plugin/client";
import { useTranslation } from "@getpaseo/plugin/client";
import {
  SettingsInput,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { messages } from "./messages";
import { sidekickSettings, type SidekickSettings } from "../shared/settings";
import { PLUGIN_VERSION } from "../shared/meta";

type FieldKey = keyof SidekickSettings;

const intRanges: Partial<Record<FieldKey, { min: number; max: number }>> = {
  snapshotDepth: { min: 0, max: 50 },
  permissionTimeoutReadMin: { min: 0, max: 1440 },
  permissionTimeoutWriteMin: { min: 0, max: 1440 },
  maxConcurrentTotal: { min: 1, max: 16 },
};

export function SidekickSettingsScreen({ theme, layout }: PluginSurfaceProps) {
  const settings = useSettings(sidekickSettings);
  const ready = settings.status === "ready";
  const values = settings.status === "ready" ? settings.values : null;
  const valuesRef = useRef<SidekickSettings | null>(null);
  if (values) valuesRef.current = values;

  const { t } = useTranslation(messages);

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
            ? `${t("set.invalid")}${settings.error}`
            : t("set.loading")}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      {saveError ? <Text style={styles.error}>{`${t("set.saveFailed")}${saveError}`}</Text> : null}

      <SettingsSection title={t("set.newDefaults")} info={t("set.newDefaultsHint")}>
        <SettingsInput
          label={t("set.defaultModel")}
          hint={t("set.defaultModelHint")}
          initialValue={values.defaultModel}
          onChangeText={(text) => saveText("defaultModel", text)}
        />
      </SettingsSection>

      <SettingsSection title={t("set.context")} info={t("set.contextHint")}>
        <SettingsSelect
          label={t("set.snapshotDepth")}
          value={String(values.snapshotDepth)}
          options={[
            { label: t("set.snapOff"), value: "0" },
            { label: t("set.snap6"), value: "6" },
            { label: t("set.snap12"), value: "12" },
            { label: t("set.snap30"), value: "30" },
          ]}
          onValueChange={(value) => save({ snapshotDepth: Number.parseInt(value, 10) })}
        />
        <SettingsSwitch
          label={t("set.actionDigest")}
          hint={t("set.actionDigestHint")}
          value={values.includeActionDigest}
          onValueChange={(value) => save({ includeActionDigest: value })}
        />
        <SettingsSelect
          label={t("set.fallbackMode")}
          value={values.contextFallback}
          options={[
            { label: t("set.fallbackAuto"), value: "auto" },
            { label: t("set.off"), value: "off" },
          ]}
          onValueChange={(value) => save({ contextFallback: value })}
        />
      </SettingsSection>

      <SettingsSection title={t("set.threads")}>
        <SettingsSwitch
          label={t("set.attachMain")}
          hint={t("set.attachMainHint")}
          value={values.attachToMain}
          onValueChange={(value) => save({ attachToMain: value })}
        />
        <SettingsSwitch
          label={t("set.aiTitles")}
          hint={t("set.aiTitlesHint")}
          value={values.aiTitles}
          onValueChange={(value) => save({ aiTitles: value })}
        />
        <SettingsInput
          label={t("set.titleModel")}
          hint={t("set.titleModelHint")}
          initialValue={values.titleModel}
          onChangeText={(text) => saveText("titleModel", text)}
        />
      </SettingsSection>

      <SettingsSection title={t("set.permissions")}>
        <SettingsSelect
          label={t("set.permPolicy")}
          value={values.permissionPolicy}
          options={[
            { label: t("set.permFollow"), value: "follow" },
            { label: t("set.permAsk"), value: "ask" },
            { label: t("set.permReadOnly"), value: "allow-readonly" },
            { label: t("set.permDeny"), value: "deny-all" },
          ]}
          onValueChange={(value) => save({ permissionPolicy: value })}
        />
        <SettingsInput
          label={t("set.permTimeoutRead")}
          hint={t("set.permTimeoutHint")}
          initialValue={String(values.permissionTimeoutReadMin)}
          onChangeText={(text) => saveInt("permissionTimeoutReadMin", text)}
        />
        <SettingsInput
          label={t("set.permTimeoutWrite")}
          hint={t("set.permTimeoutHint")}
          initialValue={String(values.permissionTimeoutWriteMin)}
          onChangeText={(text) => saveInt("permissionTimeoutWriteMin", text)}
        />
      </SettingsSection>

      <SettingsSection title={t("set.concurrency")}>
        <SettingsInput
          label={t("set.maxTotal")}
          initialValue={String(values.maxConcurrentTotal)}
          onChangeText={(text) => saveInt("maxConcurrentTotal", text)}
        />
        <SettingsSwitch
          label={t("set.expCancel")}
          hint={t("set.expCancelHint")}
          value={values.experimentalCancel}
          onValueChange={(value) => save({ experimentalCancel: value })}
        />
      </SettingsSection>

      <SettingsSection title={t("set.about")}>
        <Text style={styles.hint}>{t("set.aboutVersion", { version: PLUGIN_VERSION })}</Text>
        <Text style={styles.hint}>{t("set.aboutDesc")}</Text>
      </SettingsSection>
    </View>
  );
}
