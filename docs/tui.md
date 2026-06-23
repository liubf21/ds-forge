[文档索引](README.zh-CN.md) · [README](../README.md)

# Agent TUI 技术文档

基于 [Ink](https://github.com/vadimdemedes/ink)（React for CLI）的多轮流式对话终端，风格对标 Claude Code。

## 启动

```bash
npm run tui                                        # 新会话
npm run tui -- --cwd /path/to/project              # 指定工作目录
npm run tui -- --resume trajectories/task-xxx.json  # 恢复会话
npm run tui -- --model deepseek-v4-pro --effort max  # 切换到 Pro 模型 + 深度推理
npm run tui -- --max-turns 50                       # 限制最大轮次
npm run tui -- --agents --global-agents             # 显式加载项目 + global AGENTS.md
npm run tui -- --skills --user-skills               # 显式加载项目 + 用户 skills
```

直接运行（跳过 npm 的 `--` 分隔符）：

```bash
npx tsx --env-file-if-exists=.env tui/index.tsx --resume trajectories/task-xxx.json
```

环境变量 `DEEPSEEK_API_KEY` 必须设置。

### CLI 参数

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--cwd <path>` | `process.cwd()` | bash 工具的工作目录 |
| `--resume <path>` | — | 从已有轨迹文件恢复上下文 |
| `--model <name>` | `deepseek-v4-flash` | 模型标识 |
| `--effort <level>` | `high` | 推理力度：`high` / `max` / `off` |
| `--max-turns <n>` | `DEFAULT_MAX_TURNS` | 单次提交的最大 Agent 循环轮次 |
| `--agents` | 关 | 加载项目 AGENTS.md |
| `--global-agents` | 关 | 加载 global AGENTS.md |
| `--skills` | 关 | 加载项目 `.agents/skills` |
| `--user-skills` | 关 | 加载 `~/.agents/skills` |

## 交互

### 会话内命令

| 命令 | 说明 |
|---|---|
| `/clear` | 清空上下文，创建新轨迹文件 |
| `/history` | 切换显示全部 / 最近 12 条消息 |
| `/quit` 或 `/exit` | 保存并退出 |

### 快捷键

| 按键 | 场景 | 行为 |
|---|---|---|
| `Ctrl+C` | 任意 | 保存并退出 |
| `Esc Esc`（双击） | Agent 运行中 | 中止当前请求，回滚上下文，恢复输入 |
| `Esc Esc`（双击） | 空闲 | 撤销上一轮对话，恢复用户输入 |

双击间隔阈值 500ms。首次 `Esc` 会在状态栏提示"Press Esc again to abort/undo"。

## 架构

```
tui/
├── index.tsx        入口：解析 CLI → 创建 AgentSession → render <App>
├── app.tsx          主组件：输入框、消息列表、状态栏、键盘处理
├── chat-state.ts    useReducer 状态机 + 消息可见性裁切
├── components.tsx   UI 组件：UserBubble、AssistantBubble、ToolBlockView、FileLink
├── display.ts       纯函数：StreamEvent → LiveTurn 状态转移 + 工具显示格式化
├── history.ts       从 Forge Context 重建 TUI 气泡（用于 --resume）
├── links.ts         OSC 8 终端超链接（Cmd+click 可在 iTerm/VS Code 中打开）
├── types.ts         TUI 层类型定义
└── tui_test.ts      纯逻辑测试（无 Ink 渲染、无 API 调用）
```

### 数据流

```
用户输入
  │
  ▼
App.submit()
  ├─ dispatch({ type: "add_user" })        ← 立即显示用户气泡
  ├─ forge.runStream(text, maxTurns)       ← 启动流式 Agent 循环
  │    │
  │    ├─ StreamEvent: text_delta          → applyEvent → dispatch(live_update)
  │    ├─ StreamEvent: tool_call_start     → applyEvent → dispatch(live_update)
  │    ├─ StreamEvent: tool_result         → applyEvent → dispatch(live_update)
  │    └─ StreamEvent: turn_done           → dispatch(complete_turn)
  │
  └─ persist()                             ← 每轮结束自动保存轨迹
```

### 状态机 (chatReducer)

```
ChatState = { history: HistoryMessage[], live: LiveTurn | null }

Actions:
  reset         → { history: [], live: null }
  add_user      → 追加 UserMessage 到 history
  live_update   → 更新 live（流式中间态）
  complete_turn → live → null，追加 AssistantMessage 到 history
  live_clear    → live → null（异常/无完成事件时清理）
  undo_last     → 回退到上一个 user 消息之前
```

`history` 和 `live` 严格分离：`complete_turn` 是唯一将 live 内容转入 history 的动作，确保不会出现重复气泡。

### 中止与撤销

**中止（Agent 运行中）：**

1. 双击 `Esc` → `abortCtrlRef.current.abort()`
2. `forge.runStream` 的 `AbortSignal` 被触发，流终止
3. `forge.context.restore(snapshot)` 回滚到本轮开始前的消息快照
4. `dispatch({ type: "undo_last" })` 移除已显示的用户气泡
5. 用户输入恢复到提交前的文本

**撤销（空闲时）：**

1. 双击 `Esc` → `undo()`
2. 从 `forge.context.messages` 尾部向前找到最后一个 `user` 消息
3. `forge.context.restore(msgs.slice(0, i))` 截断
4. UI 同步回退，输入框恢复被撤销的文本

两种场景都会调用 `persist()` 保存状态。

## 模块细节

### display.ts — 事件到视图的映射

`applyEvent(turn, ev)` 是纯函数，将 `StreamEvent` 累积到 `LiveTurn`：

| 事件 | 行为 |
|---|---|
| `text_delta` | 拼接 `turn.content` |
| `tool_call_start` | 追加 `ToolBlock`（`running: true`） |
| `tool_result` | 匹配 `id`，写入 `result`，`running: false` |
| 其他 | 原样返回 |

`formatToolCommand` 对 bash 工具特殊处理：解析 JSON 提取 `command` 字段，避免显示原始 JSON。

`formatToolStatus` 将工具结果压缩为单行状态：

- 运行中 → `…`
- 空结果 → `✓`
- 单行短结果 → `✓ <result>`
- 多行结果 → `✓ N lines`

### history.ts — 轨迹恢复

`historyFromContext(messages)` 将 Forge 的 `MessageObj[]` 转为 TUI 的 `HistoryMessage[]`：

- 跳过 `system` 消息
- `user` → `UserMessage`
- `assistant` → 关联后续的 `tool` 消息，构建 `ToolBlock[]`
- `reasoning_content` fallback：仅有 reasoning 无 content 的 assistant 消息使用 reasoning 作为显示内容

### links.ts — 终端超链接

使用 [OSC 8](https://gist.github.com/egmontkob/eb114294efbcd5adb1944c9f3cb5feda) 协议生成可点击链接。`file://` URL 在 iTerm2、VS Code 终端等现代终端中支持 Cmd+click 打开。

### chat-state.ts — 可见性裁切

`visibleHistory(history, showAll)` 限制显示最近 `MAX_VISIBLE_MESSAGES`（默认 12）条消息，避免长会话撑满终端。`/history` 命令切换全量显示。

## 轨迹持久化

- 启动时创建 `trajectories/task-<timestamp>.json`
- 每轮结束后 `persist()` 覆盖写入
- `/clear` 创建新文件，旧文件保留
- 退出时（`/quit`、`Ctrl+C`、组件卸载）自动保存
- 目录可通过 `DS_FORGE_DIR` 环境变量覆盖

轨迹文件格式即 `Session` JSON，可直接用于 `--resume`、`Forge.load()`、`Forge.debug()`。

## 测试

```bash
npm run test    # 包含 TUI 测试
```

`tui_test.ts` 测试纯逻辑：`applyEvent`、`chatReducer`、`formatToolStatus`、`historyFromContext`、`visibleHistory`、OSC 8 链接生成、`AgentSession` 的 clear/resume 行为。不启动 Ink 渲染，不调用 API。
