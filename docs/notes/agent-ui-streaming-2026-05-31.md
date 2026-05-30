# Agent TUI + Streaming（2026-05-31）

## 目标

终端多轮 Agent 交互（Claude Code 风格），带 streaming。

## 架构

```
tui/index.tsx     → Forge 实例 + ink render
tui/app.tsx       → 消息列表 + 输入框 + runStream 消费
src/forge.ts      → runStream() SSE 事件源
```

## 启动

```bash
npm run tui
```

需要 `.env` 中 `DEEPSEEK_API_KEY`。

## TUI 交互

| 操作 | 说明 |
|---|---|
| Enter | 发送消息 |
| `/clear` | 清空对话 |
| `/quit` | 退出 |
| Ctrl+C | 退出 |

## 界面结构（Claude Code 风格）

```
┌ ds-forge ───────── deepseek-v4-flash ┐
│ ❯ You                                   │
│ What's the weather in Paris?            │
│ ◆ Agent                                 │
│ Let me check...▍                        │
│   ⎿ get_weather({"city":"Paris"})       │
│     → Weather in Paris: 22°C, sunny     │
╭─────────────────────────────────────────╮
│ ❯ Message the agent…                    │
╰─────────────────────────────────────────╯
```

- `Static` 渲染历史消息（避免 streaming 时全量重绘闪烁）
- `live` 状态单独渲染当前 streaming turn
- tool 块：`⎿ name(args)` + `→ result`

## 依赖（devDependencies）

- `ink` — React TUI
- `ink-text-input` — 底部输入框
- `react`

## 与 Web UI

用户明确要 TUI，已删除 `ui/` Web 方案。

## 轨迹持久化

- 新会话：启动时在 `trajectories/`（或 `DS_FORGE_DIR`）创建 `task-<ts>.json`
- 每轮 `turn_done` 后 `forge.save(path)`
- `/quit`、Ctrl+C、组件 unmount 时再 save 一次
- `--resume trajectories/task.json` 加载并恢复 UI 历史
- `/clear` 清空 context，创建**新** trajectory 文件
- header 显示当前 trajectory 文件名
