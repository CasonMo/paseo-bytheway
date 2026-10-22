/** 侧聊运行中发送消息的实际行为（对应 daemon 的 activeTurnBehavior）。 */
export type AppliedBehavior = "send" | "interrupt";

/**
 * 解析实际发送行为：
 * - 空闲 → 普通发送
 * - 运行中 → 直接打断当前回答并发送（daemon 只支持 interrupt / steer，
 *   steer 在多数 provider 上同样会中断当前轮次，与 interrupt 无可见区别，故不暴露）
 */
export function resolveSendBehavior(busy: boolean): AppliedBehavior {
  return busy ? "interrupt" : "send";
}
