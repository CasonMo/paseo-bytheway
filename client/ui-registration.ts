import type { PluginClientContext } from "@getpaseo/plugin/client";
import { threadsAsk } from "../shared/contracts";
import { messages } from "./messages";
import { requestThreadFocus } from "./panel-focus";
import { SidekickPanel } from "./panel";
import { SidekickSettingsScreen } from "./settings-screen";

function newRequestId(): string {
  return `skreq_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

let client: PluginClientContext | null = null;

/** 注册全部客户端贡献（面板 / 命令中心 / 斜杠命令 / 设置页）。文案由宿主按 App 语言解析。 */
export function registerSidekickUi(context: PluginClientContext): () => void {
  client = context;

  const cleanups: Array<() => void> = [];

  cleanups.push(
    context.addWorkspacePanel({
      id: "bytheway",
      title: messages.message("panelTitle"),
      icon: "MessagesSquare",
      context: "agent",
      locations: ["explorer", "workspace"],
      Component: SidekickPanel,
    }),
  );

  cleanups.push(
    context.addCommandCenterItem({
      id: "bytheway-open",
      title: messages.message("reg.cmdOpenPanel"),
      icon: "MessagesSquare",
      keywords: ["sidekick", "btw", "side", "侧聊", "旁路"],
      context: "agent",
      onSelect({ openPanel }) {
        openPanel("bytheway", { location: "explorer" });
      },
    }),
  );

  cleanups.push(
    context.addCommandCenterItem({
      id: "bytheway-open-settings",
      title: messages.message("reg.cmdSettings"),
      icon: "Settings2",
      keywords: ["sidekick", "侧聊", "设置"],
      context: "global",
      onSelect({ openSettings }) {
        openSettings("bytheway-settings");
      },
    }),
  );

  cleanups.push(
    context.addSettingsScreen({
      id: "bytheway-settings",
      title: messages.message("panelTitle"),
      icon: "Settings2",
      Component: SidekickSettingsScreen,
    }),
  );

  const askCommand = (
    name: string,
    description: ReturnType<typeof messages.message>,
    kind: "continue" | "new",
  ) => {
    cleanups.push(
      context.addSlashCommand({
        name,
        description,
        argumentHint: messages.message("reg.argQuestion"),
        context: "agent",
        async onSubmit({ args, agent, rpc, openPanel }) {
          const question = args.trim();
          if (!question) {
            openPanel("bytheway", { location: "explorer" });
            return;
          }
          try {
            const result = await rpc(threadsAsk, {
              mainAgentId: agent.id,
              question,
              mode: "ask",
              target: kind === "new" ? { kind: "new" } : { kind: "continue" },
              clientRequestId: newRequestId(),
            });
            requestThreadFocus({ mainAgentId: agent.id, threadId: result.threadId });
          } finally {
            openPanel("bytheway", { location: "explorer" });
          }
        },
      }),
    );
  };

  askCommand("btw", messages.message("reg.slashBtw"), "continue");
  askCommand("btw-new", messages.message("reg.slashBtwNew"), "new");

  cleanups.push(
    context.addSlashCommand({
      name: "fork",
      description: messages.message("reg.slashFork"),
      argumentHint: messages.message("reg.argFork"),
      context: "agent",
      async onSubmit({ args, agent, paseo }) {
        const page = await paseo.agents.ref(agent.id).timeline.refetch({
          direction: "tail",
          limit: 200,
          projection: "canonical",
        });
        const lines: string[] = [`以下是从会话「${agent.title ?? agent.id}」克隆的对话记录：`];
        for (const entry of page.entries) {
          const item = entry.item;
          if (item.type === "user_message") lines.push(`用户: ${item.text}`);
          else if (item.type === "assistant_message") lines.push(`助手: ${item.text}`);
        }
        await paseo.workspaces.ref(agent.workspaceId).agents.create({
          config: {
            provider: agent.model ? `${agent.provider}/${agent.model}` : agent.provider,
          },
          title: `Fork · ${agent.title ?? agent.id}`,
          prompt: args.trim() || undefined,
          attachments: [
            {
              type: "text",
              mimeType: "text/plain",
              title: `会话记录-${agent.title ?? agent.id}`,
              text: lines.join("\n\n"),
            },
          ],
        });
      },
    }),
  );

  return () => {
    for (const dispose of cleanups) dispose();
    client = null;
  };
}

/** 从面板打开本插件的设置页（client.openSettings）。返回是否成功。 */
export function openSidekickSettings(): boolean {
  try {
    if (!client) return false;
    client.openSettings("bytheway-settings");
    return true;
  } catch {
    return false;
  }
}
