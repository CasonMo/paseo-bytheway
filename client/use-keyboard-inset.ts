import { useEffect, useState, type ComponentRef, type RefObject } from "react";
import { Platform, View } from "react-native";

/**
 * 触屏 Web（iPad Safari 等）弹出键盘时只收缩 visualViewport，layout viewport 不变，
 * 面板底部输入框会被键盘遮住。返回面板底部被遮住的高度，调用方加到根节点 marginBottom 上。
 */
export function useKeyboardInset(rootRef: RefObject<ComponentRef<typeof View> | null>): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const viewport = window.visualViewport;
    if (!viewport) return;

    const measure = () => {
      const node = rootRef.current as unknown as HTMLElement | null;
      if (!node || typeof node.getBoundingClientRect !== "function") return;
      // 双指缩放不是键盘遮挡，不处理。
      if (Math.abs(viewport.scale - 1) > 0.01) {
        setInset(0);
        return;
      }
      // 加回当前已让出的 margin，避免「收缩→再测」的正反馈抖动。
      const applied = Number.parseFloat(getComputedStyle(node).marginBottom) || 0;
      const bottom = node.getBoundingClientRect().bottom + applied;
      setInset(Math.max(0, Math.round(bottom - viewport.offsetTop - viewport.height)));
    };

    measure();
    viewport.addEventListener("resize", measure);
    viewport.addEventListener("scroll", measure);
    window.addEventListener("resize", measure);
    return () => {
      viewport.removeEventListener("resize", measure);
      viewport.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, [rootRef]);

  return inset;
}