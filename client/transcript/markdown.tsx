import type { PluginTheme } from "@getpaseo/plugin";
import { openExternalUrl } from "@getpaseo/plugin/client";
import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { Image, Linking, Pressable, Text, View, type TextStyle } from "react-native";
import { copyText, useToast } from "../host-ui";
import { useT } from "../i18n";
import { parseBlocks, type Block } from "./markdown-parse";

/**
 * 轻量 Markdown 渲染器（RN 跨端）：
 * 标题 / 列表 / 引用 / 分隔线 / 代码块（带复制）/ 行内样式 / 链接 / 表格。
 */

interface MarkdownProps {
  text: string;
  theme: PluginTheme;
  compact: boolean;
  /** 流式阶段使用更轻的渲染（跳过表格解析）。 */
  streaming?: boolean;
}


/* ------------------------------------------------------------------ */
/* 行内渲染                                                             */
/* ------------------------------------------------------------------ */

const INLINE_RE =
  /(!\[[^\]]*\]\([^)]+\)|!\[[^\]]+\]|\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|_[^_]+_|\[[^\]]+\]\([^)]+\))/g;

function renderInline(
  text: string,
  theme: PluginTheme,
  keyPrefix: string,
  baseMono = false,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const regex = new RegExp(INLINE_RE.source, "g");
  let index = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    const key = `${keyPrefix}-i${index}`;
    index += 1;
    if (token.startsWith("![")) {
      const imageMatch = token.match(/^!\[([^\]]*)\]/);
      const alt = imageMatch?.[1]?.trim();
      nodes.push(
        <Text key={key} style={{ color: theme.colors.foregroundMuted }}>
          🖼 {alt && alt !== "Image" ? alt : "Image"}
        </Text>,
      );
    } else if (token.startsWith("**")) {
      nodes.push(
        <Text key={key} style={{ fontWeight: "700", color: theme.colors.foreground }}>
          {token.slice(2, -2)}
        </Text>,
      );
    } else if (token.startsWith("`")) {
      nodes.push(
        <Text
          key={key}
          style={{
            fontFamily: baseMono ? undefined : "Menlo",
            backgroundColor: theme.colors.surface2,
            color: theme.colors.foreground,
          }}
        >
          {token.slice(1, -1)}
        </Text>,
      );
    } else if (token.startsWith("*") || token.startsWith("_")) {
      nodes.push(
        <Text key={key} style={{ fontStyle: "italic" }}>
          {token.slice(1, -1)}
        </Text>,
      );
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (link) {
        nodes.push(
          <LinkText key={key} href={link[2]} label={link[1]} theme={theme} />,
        );
      } else {
        nodes.push(token);
      }
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

function LinkText({ href, label, theme }: { href: string; label: string; theme: PluginTheme }) {
  const toast = useToast();
  const t = useT();
  const onPress = () => {
    void (async () => {
      try {
        if (/^https?:\/\//i.test(href)) await openExternalUrl(href);
        else await Linking.openURL(href);
      } catch {
        try {
          await copyText(href);
          toast.show(t.linkCopied, { variant: "info" });
        } catch {
          toast.error(t.linkOpenFailed);
        }
      }
    })();
  };
  return (
    <Text onPress={onPress} style={{ color: theme.colors.accent, textDecorationLine: "underline" }}>
      {label}
    </Text>
  );
}

/* ------------------------------------------------------------------ */
/* 组件                                                                 */
/* ------------------------------------------------------------------ */

export const MarkdownText = memo(function MarkdownText({
  text,
  theme,
  compact,
  streaming,
}: MarkdownProps) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  const baseStyle = useMemo<TextStyle>(
    () => ({
      color: theme.colors.foreground,
      fontSize: compact ? 12.5 : 13.5,
      lineHeight: compact ? 19 : 21,
    }),
    [theme, compact],
  );

  return (
    <View style={{ gap: compact ? 6 : 8 }}>
      {blocks.map((block, blockIndex) => {
        const key = `b${blockIndex}`;
        switch (block.kind) {
          case "heading": {
            const size = block.level <= 1 ? 17 : block.level === 2 ? 15.5 : 14;
            return (
              <Text key={key} style={{ ...baseStyle, fontSize: compact ? size - 1 : size, fontWeight: "700" }}>
                {renderInline(block.text, theme, key)}
              </Text>
            );
          }
          case "paragraph":
            return (
              <Text key={key} style={baseStyle}>
                {renderInline(block.text, theme, key)}
              </Text>
            );
          case "quote":
            return (
              <View
                key={key}
                style={{
                  borderLeftWidth: 3,
                  borderLeftColor: theme.colors.border,
                  paddingLeft: 10,
                }}
              >
                <Text style={{ ...baseStyle, color: theme.colors.foregroundMuted }}>
                  {renderInline(block.text, theme, key)}
                </Text>
              </View>
            );
          case "hr":
            return <View key={key} style={{ height: 1, backgroundColor: theme.colors.border }} />;
          case "list":
            return (
              <View key={key} style={{ gap: 3 }}>
                {block.items.map((item, itemIndex) => (
                  <View key={`${key}-${itemIndex}`} style={{ flexDirection: "row", gap: 6 }}>
                    <Text style={{ ...baseStyle, color: theme.colors.foregroundMuted, minWidth: block.ordered ? 20 : 12 }}>
                      {block.ordered ? `${itemIndex + 1}.` : "•"}
                    </Text>
                    <Text style={{ ...baseStyle, flex: 1 }}>{renderInline(item, theme, `${key}-${itemIndex}`)}</Text>
                  </View>
                ))}
              </View>
            );
          case "code":
            return <CodeBlock key={key} lang={block.lang} code={block.code} theme={theme} compact={compact} />;
          case "image":
            return <MarkdownImage key={key} alt={block.alt} url={block.url} theme={theme} compact={compact} />;
          case "table": {
            if (streaming) {
              return (
                <Text key={key} style={baseStyle}>
                  {renderInline(block.header.join(" | "), theme, key)}
                </Text>
              );
            }
            return (
              <View key={key} style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, overflow: "hidden" }}>
                <View style={{ flexDirection: "row", backgroundColor: theme.colors.surface2 }}>
                  {block.header.map((cell, cellIndex) => (
                    <Text
                      key={`${key}-h-${cellIndex}`}
                      style={{ ...baseStyle, flex: 1, fontWeight: "600", padding: 6 }}
                    >
                      {renderInline(cell, theme, `${key}-h-${cellIndex}`)}
                    </Text>
                  ))}
                </View>
                {block.rows.map((row, rowIndex) => (
                  <View
                    key={`${key}-r-${rowIndex}`}
                    style={{
                      flexDirection: "row",
                      borderTopWidth: 1,
                      borderTopColor: theme.colors.border,
                    }}
                  >
                    {row.map((cell, cellIndex) => (
                      <Text key={`${key}-r-${rowIndex}-${cellIndex}`} style={{ ...baseStyle, flex: 1, padding: 6 }}>
                        {renderInline(cell, theme, `${key}-r-${rowIndex}-${cellIndex}`)}
                      </Text>
                    ))}
                  </View>
                ))}
              </View>
            );
          }
          default:
            return null;
        }
      })}
    </View>
  );
});

function MarkdownImage({
  alt,
  url,
  theme,
  compact,
}: {
  alt: string;
  url: string;
  theme: PluginTheme;
  compact: boolean;
}) {
  const toast = useToast();
  const t = useT();
  const [failed, setFailed] = useState(false);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const remote = /^https?:\/\//i.test(url) || /^data:image\//i.test(url);

  const fileName = (() => {
    if (!remote) {
      try {
        const clean = decodeURIComponent(url.split("?")[0] ?? "");
        const base = clean.slice(clean.lastIndexOf("/") + 1);
        if (base) return base;
      } catch {
        // ignore
      }
    }
    return null;
  })();
  const label = alt && alt !== "Image" ? alt : fileName ?? "Image";

  useEffect(() => {
    if (!remote || failed) return;
    try {
      const getSize = (Image as unknown as {
        getSize?: (uri: string, onSuccess: (w: number, h: number) => void, onFailure?: () => void) => void;
      }).getSize;
      if (typeof getSize === "function") {
        getSize(
          url,
          (width, height) => setSize({ width, height }),
          () => setFailed(true),
        );
      }
    } catch {
      // 尺寸未知时用固定高度
    }
  }, [remote, failed, url]);

  if (!remote || failed) {
    return (
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          void (async () => {
            try {
              await copyText(url);
              toast.show(t.linkCopied, { variant: "info" });
            } catch {
              toast.error(t.copyFailed);
            }
          })();
        }}
        style={{
          alignSelf: "flex-start",
          flexDirection: "row",
          alignItems: "center",
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: 8,
          paddingHorizontal: 8,
          paddingVertical: 5,
          backgroundColor: theme.colors.surface1,
        }}
      >
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: compact ? 11 : 12 }}>🖼 {label}</Text>
      </Pressable>
    );
  }

  return (
    <View style={{ alignSelf: "flex-start", width: "100%", maxWidth: 420 }}>
      <Image
        source={{ uri: url }}
        onError={() => setFailed(true)}
        resizeMode="contain"
        style={{
          width: "100%",
          ...(size ? { aspectRatio: size.width / Math.max(1, size.height) } : { height: 200 }),
          borderRadius: 8,
          backgroundColor: theme.colors.surface2,
        }}
      />
    </View>
  );
}

function CodeBlock({
  lang,
  code,
  theme,
  compact,
}: {
  lang: string;
  code: string;
  theme: PluginTheme;
  compact: boolean;
}) {
  const toast = useToast();
  const t = useT();
  const onCopy = () => {
    void (async () => {
      try {
        await copyText(code);
        toast.show(t.codeCopied, { variant: "success" });
      } catch {
        toast.error(t.copyFailed);
      }
    })();
  };
  const lineCount = code.split("\n").length;
  return (
    <View
      style={{
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: 8,
          paddingVertical: 4,
          borderBottomWidth: lineCount > 1 ? 1 : 0,
          borderBottomColor: theme.colors.border,
        }}
      >
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
          {t.codeMeta(lang, lineCount)}
        </Text>
        <Pressable accessibilityRole="button" onPress={onCopy} hitSlop={8}>
          <Text style={{ color: theme.colors.accent, fontSize: 10.5 }}>{t.copy}</Text>
        </Pressable>
      </View>
      <Text
        selectable
        style={{
          fontFamily: "Menlo",
          fontSize: compact ? 11 : 11.5,
          lineHeight: compact ? 16 : 17,
          color: theme.colors.foreground,
          padding: 8,
        }}
      >
        {code}
      </Text>
    </View>
  );
}
