import { test } from "vitest";
import { resolveSendBehavior } from "./send-behavior";

test("空闲时普通发送", () => {
  if (resolveSendBehavior(false) !== "send") throw new Error("idle should send");
});

test("运行中直接打断发送", () => {
  if (resolveSendBehavior(true) !== "interrupt") throw new Error("busy should interrupt");
});
