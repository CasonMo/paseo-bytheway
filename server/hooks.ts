import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { SidekickSettings } from "../shared/settings";
import { findThreadByAgentId } from "./registry";

const timers = new Set<ReturnType<typeof setTimeout>>();

function permissionKind(request: { detail?: unknown; kind?: string }): "read" | "write" {
  const type = (request.detail as { type?: string } | undefined)?.type;
  return type === "read" || type === "search" ? "read" : "write";
}

/**
 * 侧聊 agent 的权限策略与超时兜底（仅对本插件的线程生效）：
 * - ask（默认）：等待用户在面板处理；超时后自动拒绝（只读/写分别计时）
 * - allow-readonly：只读类请求自动放行，写类走超时
 * - deny-all：立即拒绝
 */
export function registerPermissionAutoHandlers(
  server: PluginServerContext,
  readSettings: () => Promise<SidekickSettings>,
): () => void {
  server.on("agent.permission_requested", async (event, { paseo }) => {
    try {
      const agentId = event.agent.id;
      if (!findThreadByAgentId(agentId)) return; // 只处理本插件的侧聊 agent

      const settings = await readSettings();
      const kind = permissionKind(event.request);
      const ref = paseo.agents.ref(agentId);

      if (settings.permissionPolicy === "deny-all") {
        await ref
          .respondToPermission({
            requestId: event.request.id,
            response: { behavior: "deny", message: "侧聊权限策略为全部拒绝（可在设置中调整）" },
          })
          .catch(() => {});
        return;
      }

      if (settings.permissionPolicy === "allow-readonly" && kind === "read") {
        await ref.respondToPermission({ requestId: event.request.id, response: { behavior: "allow" } }).catch(() => {});
        return;
      }

      const minutes = kind === "read" ? settings.permissionTimeoutReadMin : settings.permissionTimeoutWriteMin;
      if (minutes <= 0) return;
      const timer = setTimeout(() => {
        timers.delete(timer);
        void (async () => {
          try {
            const snapshot = await paseo.agents.ref(agentId).refresh();
            const pending = snapshot?.agent.pendingPermissions ?? [];
            if (!pending.some((entry) => entry.id === event.request.id)) return; // 已被处理
            await paseo.agents.ref(agentId).respondToPermission({
              requestId: event.request.id,
              response: { behavior: "deny", message: "侧聊权限请求超时未处理，已自动拒绝（可在面板重新发起）" },
            });
          } catch {
            // 会话可能已结束
          }
        })();
      }, minutes * 60_000);
      timers.add(timer);
    } catch (error) {
      console.error("[bytheway] permission auto-handler failed", error);
    }
  });

  return () => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };
}
