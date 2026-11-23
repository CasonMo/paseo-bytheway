# ByTheWay 侧聊（paseo-bytheway）

不打断主会话的旁路侧聊（Paseo 插件）。
Side chats for Paseo agent sessions — ask questions or run small side tasks without touching the main session.

## 功能

- **实时执行流**：侧聊 agent 的流式文本、思考、工具调用、待办、turn 状态与用量实时直播（不轮询）。
- **实时线程目录**：订阅 Paseo 的 agent_update 实时刷新线程状态；列表元数据每 60 秒兜底刷新，服务端一次 `agents.list` 批量映射，不再逐线程 refresh。
- **线程化**：`/btw` 续聊、`/btw-new` 新开；新线程默认继承主会话原有 Mode/思考/Features；`/fork` 克隆当前会话。
- **Subagent 管理**：当前侧聊 agent 派生的 Paseo 子 agent 与 provider 原生 subagent 统一显示在输入框上方；没有 subagent 时整块隐藏，有运行中的 subagent 时显示实时数量。点开可查看状态、打开详情、分离或归档 Paseo 子 agent，并可一键清理已完成的 subagent。
- **上下文**：默认「agent 直连」——侧聊通过 Paseo 内置工具按需读取主会话最新进展；首轮附轻量快照；工具不可用时自动降级为被动增量同步。
- **图片/文件附件**：输入框回形针按钮选择图片或文件，桌面端也可直接从剪贴板粘贴图片/文件；图片走 Paseo 原生图片通道直达模型，其它文件落盘到插件数据目录后以路径引用（侧聊 agent 用文件工具读取）。最多 8 个、单文件 ≤ 10MB、合计 ≤ 20MB；可以不输文字只发附件。已发送的附件会在消息气泡里回显（图片缩略图、文件名牌），点击缩略图可在面板内放大预览。选择/粘贴目前仅桌面（web）端支持，移动端照常发文本。
- **转录零落盘**：Paseo agent 转录是唯一数据源；插件只持久化线程注册表、模型配置记忆与用户上传的附件副本（图片与文件，按 线程/消息 分组于 `~/.paseo/plugin-data/paseo-bytheway/uploads/`），不复制问答正文；删除线程时清理其附件，遗留附件目录 14 天后自动清扫。
- **权限内联处理**：新线程继承主会话的 Mode、思考档与 provider features（如 opencode `auto_accept`），权限默认与主会话一致；面板内批准/拒绝；提问类请求渲染为分步表单（一次一题、单选自动前进、最后统一提交）；默认跟随主会话由 Paseo 原生处理，可选策略（询问+超时自动拒绝 / 自动放行只读 / 全部拒绝）。
- **停止**：先尝试 MCP 辅助取消，5 秒未生效自动提示「打开标签页停止」。
- **后台任务**：输入框上方显示侧聊 agent 的 background work，可一键停止；打断后的旧工具不会看起来永远卡在 running。
- **入口可见**：workspace 侧栏行显示侧聊数量 badge；每个主 agent 的 composer 旁有「侧聊」入口。
- **触屏键盘适配**：iPad 等触屏 Web 端弹出软键盘时，面板底部输入区按 visualViewport 实测遮挡高度自动上抬，收起后复原；桌面与原生端不受影响。
- **运行中**：按钮互斥——回答中只显示「停止」，空闲时只显示「发送」；回答中按 Enter 发送会打断当前回答、重新开始一轮（toast 提示）。
- **模型切换**：新建侧聊可跨 Provider 选模型；已有线程仅支持同一 Provider 内**原地**切换模型（会话保持连续，provider 创建时固定）。切换直接走 Paseo 0.16 的 composer/agent 控制接口，毫秒级生效，不再等待辅助 agent。
- **模型配置记忆**：默认开启。按 `provider/model` 记住用户实际使用过的 Mode、思考档和 Features；下次选到同一模型自动恢复，不同模型互不影响。可在设置中关闭。以「发送/重建成功后实际生效的值」为准，选择「跟随主会话」不会套用模型记忆。
- **Provider 原生控制**：不再用 Chat/Build 归组，而是动态读取 Paseo 的 modes、thinkingOptions 和 features。Codex、Claude、OpenCode、Pi、Qoder 等 provider 返回什么，侧聊就显示什么；没有对应能力的 provider 自动隐藏控件。
- **思考模式**：输入区「思考」按钮默认跟随主会话；同模型时继承主会话当前思考档，换模型时使用目标模型默认档。已有线程原地切换，subagent ID 不变。
- **体验**：AI 线程标题（可配置标题模型）、手动重命名、线程标签 ✕ 一键关闭归档、线程列表一键复制 Agent ID、状态圆点、Tab 线程切换、会话顶部显示最初提问，智能贴底滚动（跟随流式输出；上翻即停，滚回底部附近或点「回到底部」恢复）、底部「提 Issue / 提功能」直达 GitHub、界面语言跟随 Paseo App、宿主 Markdown 正文、更新横幅；桌面端输入框 Enter 发送、Shift+Enter 换行（与 Paseo 主输入框一致）。

## 命令

| 命令 | 行为 |
|---|---|
| `/btw <问题>` | 继续当前侧聊线程（无则新开），并打开面板；不带问题时仅打开面板 |
| `/btw-new [问题]` | 新开一条侧聊线程；不带问题时打开面板并进入新线程草稿，可先选 provider/model |
| `/fork [提示词]` | 克隆当前会话转录为新并行 agent |

命令创建或续聊线程后，面板会立即刷新并选中对应线程。也可以从 Command Center 打开「ByTheWay 侧聊」面板或「ByTheWay 设置」。

## 开发

```bash
npm install
npm run typecheck   # TypeScript
npm test            # vitest（reducer / 转换逻辑 / 发送行为）
npm run smoke       # 端到端：直连本地 daemon（使用 ~/.paseo/local-credential）
npm run busy-behavior-check  # 运行中发送：busy→interrupt 当前轮并 toast 提示（需本地 daemon）
npm run thinking-switch-check # 校验同一 subagent 的思考档真实切换（需本地 daemon）
npm run provider-controls-check # 校验动态 mode/feature 原地切换（需本地 daemon）

paseo plugin install /path/to/paseo-bytheway
paseo plugin reload paseo-bytheway
paseo plugin logs paseo-bytheway
```

- 功能、设置与数据访问说明见 `OVERVIEW.md`
- 仓库工作规则见 `AGENTS.md`

## 架构速览

```
Panel (client) ── RPC（创建/发送/归档/重建…）──▶ Daemon 插件（注册表 / 上下文 / 清扫）
     │                                                      │
     └── timeline.subscribe()（实时流，直连）◀── 侧聊 Agent（labels: sidekick=1）
```

- 直播读全部在客户端（订阅）；变更写全部走 daemon RPC；
- 时间线用纯函数 reducer 处理增量/替换/断线恢复；
- Subagent 列表由 Paseo 子 agent 快照与 `agent.provider_subagents.update` 事件合并而来；
- 模型配置记忆保存在 `model-configs.json`（只含 Mode / 思考档 / Features 等控制项，不含对话内容），最多保留最近 50 个模型；
- 已有线程的模型/思考/Mode/Features 切换由面板直接调用 Paseo composer 控制接口；AI 标题与实验性取消使用 `background: true` 的临时 helper，不会出现在默认列表、tab 或通知里；
- 线程标题、置顶和被动同步游标写入 Paseo agent metadata；插件数据丢失时可从 agent 侧恢复。
- 上下文模式：`linked`（默认，agent id 直连）/ `passive`（被动增量同步）/ 快照关闭。
