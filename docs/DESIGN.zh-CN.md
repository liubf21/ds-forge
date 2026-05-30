[English](../DESIGN.md) · [文档索引](README.zh-CN.md)

# ds-forge 设计文档

## 设计哲学

好的 Agent 运行时应该是一根**细线，而不是框架**。它只连接三件事——模型、消息历史、工具集——而不对 prompt 结构、工具语义或控制流强加意见。DeepSeek V4 的 API 与 OpenAI 兼容，HTTP 层由 `openai` SDK 处理；我们只在上面加真正必要的东西。

三个约束驱动了所有决策：

1. **最小表面积** — 一个类（`Forge`）、一个工厂（`tool()`）、一件事（连接 model ↔ context ↔ tools）
2. **无魔法** — JSON Schema 显式声明；TS 类型在运行时被擦除，不要假装类型安全
3. **可调试** — 每次状态转移都产生可序列化产物；轨迹是一等公民

## 架构

```
User Code
    │
    ▼
┌─────────────────────────────────┐
│            Forge                 │  编排器
│  ┌─────────┐  ┌──────────────┐  │
│  │ Context  │  │ ToolRegistry │  │
│  │(messages)│  │  (callables) │  │
│  └────┬─────┘  └──────┬───────┘  │
│       │               │          │
│  ┌────┴───────────────┴──────┐   │
│  │        _send()            │   │
│  │  truncate → API → record  │   │
│  └───────────────────────────┘   │
└─────────────────────────────────┘
         │               ▲
         ▼               │
┌─────────────┐    ┌──────────┐
│  Session     │    │  Forge   │
│  (JSON)      │    │  .load() │
│  save/load   │    │  .debug()│
└─────────────┘    └──────────┘
```

## 模块边界

各模块之间**零内部依赖**（除 `forge.ts` 负责串联外）。这意味着你可以单独使用 `Context` 做 token 计数，或单独使用 `ToolRegistry` 管理 schema。

| 模块 | 依赖 | 职责 |
|---|---|---|
| `types.ts` | 无 | 共享接口，无逻辑 |
| `tools.ts` | types.ts | `tool()` 工厂 + `ToolRegistry` |
| `context.ts` | types.ts | 消息列表、token 计数、截断 |
| `bash.ts` | tools.ts | 预置 bash 执行工具 |
| `session.ts` | types.ts, context.ts, forge.ts（仅类型） | JSON 序列化 |
| `forge.ts` | 以上全部 | 编排器——唯一有横切关注点的模块 |

## 关键设计决策

### 1. 工具可执行函数不序列化

`Session` 只存 tool **schema**（name、description、parameters），从不存 `execute` 函数。这是刻意的：

- 可执行代码无法有意义地随 JSON 持久化
- 工具实现可能在会话之间变化
- `Forge.load()` 时用户重新提供 tools；`validateTools()` 检查名称是否匹配，不匹配则警告

工具不匹配不会阻止加载——你可能故意只回放消息而不执行工具。

### 2. JSON Schema 显式声明，非推导

Python 版 `@tool` 装饰器用 `inspect` 从类型注解生成 JSON Schema。TypeScript 类型在运行时被擦除，等价物不存在。我们选择显式 JSON Schema 而非 Zod：

- 零额外依赖
- 与用户偏好的任意 schema 生成器兼容
- TS 类型与 JSON Schema 之间没有隐藏映射

若需要 Zod，接入很简单：

```typescript
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

const schema = zodToJsonSchema(z.object({ city: z.string() }));
```

### 3. Token 计数是启发式且可插拔

默认：`JSON.stringify(messages).length / 4`。对英文文本约 85% 准确，但零依赖。`Context.tokenCounter` 可赋值——换成 `tiktoken` 或任意估算器：

```typescript
ctx.tokenCounter = (msgs) => myAccurateCounter(msgs);
```

### 4. 工具错误自我修正

工具调用失败时（JSON 解析错误、执行异常、未知工具名），错误字符串作为 tool result 回传给模型。模型看到后可以用修正后的参数重试。没有专门的错误通道，不向上抛异常——文本进，文本出。

### 5. Debug 是无状态的

`Forge.debug()` 创建**临时** OpenAI 客户端，发送 messages，返回原始响应，然后退出。不创建 Forge 实例、不修改文件、不进入 Agent 循环。这意味着：

- Debug 不会意外改变状态
- 支持原始消息列表或 session 文件（自动检测）
- 返回 `{ role, content, tool_calls }`——完整检查，不只是文本

### 6. 截断是 FIFO，保留 system

每次 API 调用前，`truncate()` 删除最旧非 system 消息，直到估算 token 数 fit `maxTokens`。若只剩 system 仍超限，则抛错——应缩短 system prompt 或提高 `maxTokens`。默认 128K 保守预算；长轨迹可显式调高 `maxTokens`。

### 7. `bashTool` 是完整 shell，不是沙箱

`bashTool` 通过 `child_process.exec` 执行任意 shell 字符串。仅有 **cwd**、**timeout**、**maxOutput** 三类约束，**没有**命令 allowlist：对 shell 字符串做启发式过滤不是权限模型，只会带来虚假安全感。

适用场景：用户主动授权的本地开发 Agent（TUI、`examples/agent.ts`）。缓解手段是运维层面的（限定 cwd、system prompt 提醒破坏性命令），而非在 bash 上打补丁。

若面向不可信 prompt 或多租户，应增加结构化工具（`read_file`、`list_dir`、`grep` 等），用类型化参数和受控实现；未来的 `safeFsTools()` 应与 `bashTool` 并列，而不是塞进 bash。

## 数据流

### 单轮（`chat`）

```
User → forge.chat("Hi")
  → context.addUser("Hi")
  → _send()
    → context.truncate()
    → client.chat.completions.create(messages, tools?)
    → if tool_calls: context.addAssistant(content, tool_calls, reasoning_content), return JSON
    → else: context.addAssistant(content), return text
```

### Agent 循环（`run`）

```
User → forge.run("Task", maxTurns=10)
  → context.addUser("Task")
  → for turn in 0..maxTurns:
    → context.truncate()
    → client.chat.completions.create(messages, tools)
    → if no tool_calls: break, return content
    → context.addAssistant(content, tool_calls, reasoning_content)
    → for each tool_call:
      → json.parse(arguments)
      → registry.execute(name, args)
      → context.addToolResult(id, result, name)
  → return "[Max turns reached]" if loop exhausted
```

### 持久化往返

```
forge.save("s.json")
  → Session.fromForge(forge)      // 快照 model, system, messages, tool specs
  → JSON.stringify → writeFile

Forge.load("s.json", { tools })
  → Session.load("s.json")        // 解析 JSON
  → new Forge({ model, system, tools })
  → forge.context = Context.fromDicts(session.messages)
  → validateTools(registry)        // 不匹配则警告
```

## 约定

- **消息在 run 期间只追加**。唯一变异是 `truncate()`（FIFO 淘汰）和 `addSystem()`（替换）。
- **System prompt 在 index 0**，截断不会淘汰它。用 `addSystem()` 替换。
- **Tool call ID** 由 API 生成，我们在 `addToolResult()` 中原样传递。
- **`chat()` vs `run()`**：`chat()` 是单轮——tool call 以 JSON 文本返回。`run()` 是多轮——tool call 自动执行。UI 用 `chat()`，自主 Agent 用 `run()`。

## 权衡

| 选择 | 收益 | 代价 |
|---|---|---|
| `openai` SDK 作 HTTP 层 | 重试、流式、错误处理开箱即用 | 多一个依赖（但不可避免） |
| 不用 pydantic/Zod 做 schema | 无魔法、依赖少 | 参数定义较冗长 |
| char/4 token 计数 | 零依赖、快 | 非英文文本约 85% 准确 |
| 显式 JSON Schema | 可移植、可调试 | schema 与 execute 之间无类型安全 |
| 工具可执行函数不序列化 | 代码与数据分离清晰 | load 时必须重新提供 tools |

## DeepSeek V4 集成

V4 原理与 API 语义见 [deepseek-v4.md](deepseek-v4.md)。本节只记录 ds-forge 的默认选择与实现状态。

### 默认配置

| 项 | 值 | 说明 |
|---|---|---|
| model | `deepseek-v4-flash` | 对齐官方 legacy `deepseek-chat` 当前路由的低成本定位 |
| `reasoningEffort` | 有 tools 时 `high`，无 tools 时 `off` | 显式注入 API；与 DeepSeek 默认（thinking on + high）一致，但无 tools 时主动关 thinking 以省钱 |
| `reasoning_content` | 存于 `Context`，原样回传 | 含 tool call 时 API 要求，否则 400 |

CLI：`--effort high|max|off`（`agent.ts`、`tui`）。

### 待改进

1. `runStream` 增加 `reasoning_delta` 事件——UI 可展示 thinking
2. 截断策略分层：含 `tool_calls` 的 assistant 消息不可 strip `reasoning_content`
3. Think Max：`reasoningEffort: "max"` + `maxTokens` ≥ 384K
