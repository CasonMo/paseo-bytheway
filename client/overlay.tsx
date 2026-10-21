import type { PluginTheme } from "@getpaseo/plugin";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { useT } from "./i18n";

/**
 * 面板内浮层（底部弹层式）。
 * 不复用宿主 Modal：在面板容器内绝对定位，跨平台行为可控。
 */
export function OverlaySheet({
  open,
  onClose,
  title,
  theme,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  theme: PluginTheme;
  compact?: boolean;
  children: ReactNode;
}) {
  const t = useT();
  if (!open) return null;
  return (
    <View
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 100,
        justifyContent: "flex-end",
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t.close}
        onPress={onClose}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: "rgba(0,0,0,0.42)",
        }}
      />
      <View
        style={{
          backgroundColor: theme.colors.surface1,
          borderTopLeftRadius: 14,
          borderTopRightRadius: 14,
          borderWidth: 1,
          borderColor: theme.colors.border,
          maxHeight: "72%",
        }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            paddingHorizontal: 12,
            paddingVertical: 8,
            borderBottomWidth: 1,
            borderBottomColor: theme.colors.border,
          }}
        >
          <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600", flex: 1 }}>
            {title}
          </Text>
          <Pressable accessibilityRole="button" onPress={onClose} hitSlop={10}>
            <Text style={{ color: theme.colors.accent, fontSize: 12 }}>{t.close}</Text>
          </Pressable>
        </View>
        <View style={{ padding: 10 }}>{children}</View>
      </View>
    </View>
  );
}
