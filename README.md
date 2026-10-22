# ByTheWay 侧聊（paseo-bytheway）

不打断主会话的旁路侧聊（Paseo 插件）。
Side chats for Paseo agent sessions — ask questions or run small side tasks without touching the main session.

## 功能

- **实时执行流**：侧聊 agent 的流式文本、思考、工具调用、待办、turn 状态与用量实时直播（不轮询）。
- **线程化**：`/btw` 续聊、`/btw-new` 新开；`/side` / `/side-new` 为 Build（干活）模式；`/fork` 克隆当前会话。
- **上下文**：默认「agent 直连」——侧聊通过 Paseo 内置工具按需读取主会话最新进展；首轮附轻量快照；工具不可用时自动降级为被动增量同步。
- **转录零落盘**：Paseo agent 转录是唯一数据源；插件只持久化线程注册表（`~/.paseo/plugin-data/paseo-bytheway/`）。
- **权限内联处理**：面板内批准/拒绝；支持策略（询问 / 自动放行只读 / 全部拒绝）与分级超时自动拒绝。
- **停止**：先尝试 MCP 辅助取消，5 秒未生效自动提示「打开标签页停止」。
- **模型切换**：新建侧聊可跨 Provider 选模型；已有线程仅支持同一 Provider 内**原地**切换模型（会话保持连续，provider 创建时固定）。
- **体验**：AI 线程标题（可配置标题模型）、手动重命名、状态圆点、Tab 线程切换、强制贴底滚动、中英双语界面；桌面端输入框 Enter 发送、Shift+Enter 换行（与 Paseo 主输入框一致）。

## 命令

| 命令 | 行为 |
|---|---|
| `/btw <问题>` | 继续当前侧聊线程（无则新开），并打开面板；不带问题时仅打开面板 |
| `/btw-new <问题>` | 新开一条侧聊线程 |
| `/side <任务>` | 继续当前 Build 线程 |
| `/side-new <任务>` | 新开一条 Build 线程 |
| `/fork [提示词]` | 克隆当前会话转录为新并行 agent |

也可以从 Command Center 打开「ByTheWay 侧聊」面板或「ByTheWay 设置」。

## 开发

```bash
npm install
npm run typecheck   # TypeScript
npm test            # vitest（reducer / 转换逻辑）
npm run smoke       # 端到端：直连本地 daemon（需 PASEO_PASSWORD 或 ~/.paseo/local-credential）

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
- 上下文模式：`linked`（默认，agent id 直连）/ `passive`（被动增量同步）/ 快照关闭。
