import type { PluginClientContext } from "@getpaseo/plugin/client";
import { threadsAsk } from "../shared/contracts";
import { detectLang, regStrings, type Lang } from "./i18n";
import { SidekickPanel } from "./panel";
import { SidekickSettingsScreen } from "./settings-screen";

function newRequestId(): string {
  return `skreq_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 面板标题、命令描述等注册文案在注册时固化，因此语言变化时整体注销并重建。
 */

let client: PluginClientContext | null = null;
let cleanups: Array<() => void> = [];
let lang: Lang = "zh";

function rebind(): void {
  for (const dispose of cleanups) dispose();
  cleanups = [];
  const context = client;
  if (!context) return;
  const t = regStrings[lang];

  cleanups.push(
    context.addWorkspacePanel({
      id: "bytheway",
      title: t.panelTitle,
      icon: "MessagesSquare",
      context: "agent",
      locations: ["explorer", "workspace"],
      Component: SidekickPanel,
    }),
  );

  cleanups.push(
    context.addCommandCenterItem({
      id: "bytheway-open",
      title: t.cmdOpenPanel,
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
      title: t.cmdSettings,
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
      title: t.settingsTitle,
      icon: "Settings2",
      Component: SidekickSettingsScreen,
    }),
  );

  const askCommand = (
    name: string,
    description: string,
    _usage: string,
    mode: "ask" | "work",
    kind: "continue" | "new",
  ) => {
    cleanups.push(
      context.addSlashCommand({
        name,
        description,
        argumentHint: mode === "work" ? t.argTask : t.argQuestion,
        context: "agent",
        async onSubmit({ args, agent, rpc, openPanel }) {
          const question = args.trim();
          if (!question) {
            // 不带问题时只打开面板（跳转到对应侧聊），不创建线程
            openPanel("bytheway", { location: "explorer" });
            return;
          }
          try {
            await rpc(threadsAsk, {
              mainAgentId: agent.id,
              question,
              mode,
              target: kind === "new" ? { kind: "new" } : { kind: "continue" },
              sendBehavior: "auto",
              clientRequestId: newRequestId(),
            });
          } finally {
            openPanel("bytheway", { location: "explorer" });
          }
        },
      }),
    );
  };

  askCommand("btw", t.slashBtw, t.slashUsageBtw, "ask", "continue");
  askCommand("btw-new", t.slashBtwNew, t.slashUsageBtwNew, "ask", "new");
  askCommand("side", t.slashSide, t.slashUsageSide, "work", "continue");
  askCommand("side-new", t.slashSideNew, t.slashUsageSideNew, "work", "new");

  cleanups.push(
    context.addSlashCommand({
      name: "fork",
      description: t.slashFork,
      argumentHint: t.argFork,
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
}

/** 注册全部客户端贡献（面板 / 命令中心 / 斜杠命令 / 设置页）。 */
export function registerSidekickUi(context: PluginClientContext): () => void {
  client = context;
  lang = detectLang();
  rebind();
  return () => {
    for (const dispose of cleanups) dispose();
    cleanups = [];
    client = null;
  };
}

/** 由面板 / 设置页在语言解析后调用；变化时重建注册文案。 */
export function applyUiLanguage(next: Lang): void {
  if (!client || next === lang) return;
  lang = next;
  rebind();
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
