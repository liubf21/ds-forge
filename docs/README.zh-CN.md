# ds-forge

[English](../README.md)

面向 DeepSeek V4 的轻量 Agent 运行时。在 OpenAI 兼容 API 之上封装上下文管理、工具调用与会话持久化。

## 文档

| 文档 | 说明 |
|---|---|
| **本文** | 安装、快速开始、API 参考、示例 |
| [deepseek-v4.md](deepseek-v4.md) | DeepSeek V4 架构原理、API、Agent 调用语义（通用） |
| [DESIGN.zh-CN.md](DESIGN.zh-CN.md) | 架构与设计取舍（含 ds-forge V4 集成默认） |
| [mcp.md](mcp.md) | MCP 协议原理（从 tool calling 讲起） |
| [llm-protocols.md](llm-protocols.md) | OpenAI / Anthropic / Gemini 等 API 协议对比 |

## 安装

```bash
npm install
cp .env.example .env   # 填入 API Key
```

`npm run demo` / `demo:mcp` 会自动加载 `.env`（`tsx --env-file-if-exists`）。若直接运行示例：`npx tsx --env-file=.env examples/...`

## 快速开始

```typescript
import { Forge, tool } from "ds-forge";

const getWeather = tool({
  name: "get_weather",
  description: "Get current weather for a city.",
  parameters: {
    type: "object",
    properties: {
      city: { type: "string", description: "City name" },
    },
    required: ["city"],
  },
  execute: async (args) => `Weather in ${args.city}: 22°C, sunny`,
});

const forge = new Forge({
  system: "You are a helpful assistant.",
  tools: [getWeather],
});

await forge.run("What's the weather in Paris?");
```

## API

### `Forge`

主入口——串联 API 客户端、上下文与工具。

```typescript
const forge = new Forge({
  apiKey?: string;       // 默认：process.env.DEEPSEEK_API_KEY
  model?: string;        // 默认："deepseek-v4-flash"
  reasoningEffort?: "high" | "max" | "off";  // 默认：有 tools 时 "high"，否则 "off"
  system?: string;       // 系统提示词
  tools?: Tool[];        // 已注册工具
  maxTokens?: number;    // 默认：128_000
  baseURL?: string;      // 默认："https://api.deepseek.com/v1"
});
```

DeepSeek 官方示例使用 `https://api.deepseek.com` 作为 `base_url`。当前默认值保留 OpenAI 风格的 `/v1` 路径以兼容 SDK；如果你的网关要求官方根地址，可显式覆盖 `baseURL`。

**方法：**

| 方法 | 说明 |
|---|---|
| `chat(message, extra?)` | 单轮对话。返回文本；若有 tool call 则返回 JSON。 |
| `run(message?, maxTurns?, extra?)` | Agent 循环。自动执行工具并将结果回传，直到模型结束或达到 `maxTurns`（默认 `2000`）。 |
| `runStream(message?, maxTurns?, extra?)` | 同 `run`，但以 `StreamEvent` 流式 yield（文本增量、工具调用、结果）。 |
| `resume(message?, maxTurns?, extra?)` | `run` 的别名——加载会话后继续对话时语义更清晰。 |
| `save(path)` | 将对话持久化到 JSON 文件。 |
| `Forge.load(path, config?)` | 从已保存会话恢复。工具需重新提供（可执行函数无法序列化）。 |
| `Forge.debug(path, config?)` | 无状态回放。从 JSON（原始消息列表或 session 格式）加载，发一次 API 请求，返回 `{ role, content, tool_calls }`。无 Agent 循环，无副作用。 |

### `tool()`

从定义对象创建 `Tool` 的工厂函数。

```typescript
const myTool = tool({
  name: string;           // 须匹配 ^[a-zA-Z0-9_-]+$
  description: string;    // 展示给模型的说明
  parameters: JsonSchema; // 参数的 JSON Schema
  execute: (args: Record<string, unknown>) => string | Promise<string>;
});
```

需要 OpenAI 格式的 tool spec 时，使用 `ToolRegistry.toOpenAISpecs()`。

### `ToolRegistry`

工具的集合，支持查找与批量序列化。

```typescript
const reg = new ToolRegistry();
reg.register(myTool);
reg.has("myTool");              // boolean
reg.get("myTool");              // Tool | undefined
await reg.execute("myTool", { key: "value" });
reg.toOpenAISpecs();           // OpenAI 格式的 tool specs
```

执行过程中的错误会被捕获并以字符串形式返回——模型可以据此自我修正。

### `Context`

有序消息列表，带 token 估算与自动截断。

```typescript
const ctx = new Context();
ctx.addSystem("You are helpful.");
ctx.addUser("Hello!");
ctx.addAssistant("Hi!");
ctx.addToolResult("call_1", "result", "toolName");
ctx.tokenCount();       // 字符数 / 4 启发式，可通过 ctx.tokenCounter 替换
ctx.truncate();          // FIFO 淘汰，保留 system 消息
ctx.toList();            // OpenAI 格式的 message dict
ctx.clear();
Context.fromDicts(dicts); // 从原始 dict 重建
```

### `Session`

可序列化的对话快照。存储消息与 tool schema——**不**存储可执行函数。

```typescript
Session.fromForge(forge);     // 快照
session.save("path.json");
const s = Session.load("path.json");
s.validateTools(registry);    // 检查 tool 名称是否与已注册的可执行函数一致
```

**JSON 格式：**

```json
{
  "version": "0.1.0",
  "model": "deepseek-v4-flash",
  "system": "You are helpful.",
  "tools": [
    { "type": "function", "function": { "name": "...", "description": "...", "parameters": {} } }
  ],
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." }
  ],
  "metadata": { "created_at": "...", "message_count": 4 }
}
```

### `AgentSession`

Coding agent 可选 preset——包装 `Forge`，提供默认 system prompt、bash 工具与 trajectory 持久化。`npm run tui` 与 `examples/agent.ts` 均使用它。

```typescript
const session = AgentSession.open({ cwd: "/my/project", resume: "trajectories/task.json" });
await session.forge.run("list files in src/");
session.save();                          // 写入 session.trajPath
session.clear();                         // 新建 trajectory 并重置 context
```

**System prompt：** 默认定义在 `src/system.ts`（`codingAgentSystem`）。新建会话可用 `system: "..."` 覆盖。`--resume` 默认使用 trajectory 内保存的 prompt；同时传 `system:` 会立即通过 `context.addSystem()` 替换。

```typescript
AgentSession.open({ cwd, system: "You are a security reviewer." });
```

### `bashTool`

通过 `child_process.exec` 提供**完整 shell 权限**，**非沙箱**。可配置：`cwd`、`timeout`、`maxOutput`。无命令 allowlist；见 DESIGN.md §7。需要受限环境时，请注册结构化工具，不要在 bash 字符串上打补丁。

```typescript
import { bashTool } from "ds-forge";

forge.tools.register(bashTool({ cwd: "/my/project", timeout: 60_000 }));
```

## 常见模式

### 带校验的工具

```typescript
const divide = tool({
  name: "divide",
  description: "Divide two numbers.",
  parameters: {
    type: "object",
    properties: {
      a: { type: "number", description: "Numerator" },
      b: { type: "number", description: "Denominator" },
    },
    required: ["a", "b"],
  },
  execute: async (args) => {
    const a = Number(args.a);
    const b = Number(args.b);
    if (b === 0) return "Error: division by zero";
    return String(a / b);
  },
});
```

### 自定义 token 计数器

```typescript
import { Context } from "ds-forge";

const ctx = new Context();
ctx.tokenCounter = (msgs) => {
  // 可接入 tiktoken 或任意估算器
  return msgs.reduce((n, m) => n + JSON.stringify(m).length, 0) / 4;
};
```

### 调试工作流

```bash
# 1. 保存会话
forge.save("debug.json");

# 2. 手动编辑 debug.json 中的 messages

# 3. 回放
npx tsx -e "
  import { Forge } from './src/index.js';
  const msg = await Forge.debug('debug.json');
  console.log(msg);
"
```

### 加载并继续

```typescript
const forge = Forge.load("session.json", { tools: [getWeather, calculate] });
await forge.resume("Now check Tokyo too.");
```

## Agent TUI

终端交互式 Agent（Claude Code 风格），支持 streaming、bash 工具、轨迹自动持久化。

```bash
npm run tui                                          # 新会话
npm run tui -- --cwd /path/to/project                # 指定工作目录
npm run tui -- --resume trajectories/task-xxx.json   # 恢复已保存会话
```

`--` 是 npm 的语法：其后的参数会传给脚本，而不是被 npm 自己解析。若不想写 `--`，可直接运行：

```bash
npx tsx --env-file-if-exists=.env tui/index.tsx --resume trajectories/task-xxx.json
```

**CLI 参数：** `--cwd`、`--resume <path>`、`--model`、`--max-turns`

**会话内命令：** `/clear`（新建 trajectory）、`/quit`、Ctrl+C

**轨迹文件：** 默认保存到 `./trajectories/`（可用 `DS_FORGE_DIR` 覆盖）。启动时创建 `task-<timestamp>.json`，每轮对话结束及退出时自动写入；header 显示当前文件名。

非交互式 CLI 见 `examples/agent.ts`，持久化模型相同。

## 运行示例

```bash
npm run demo        # 需在 .env 中配置 DEEPSEEK_API_KEY
npm run demo:mcp    # MCP playground
npm run test        # 无需 API Key（MCP + TUI）
npm run tui         # Agent TUI（终端多轮对话）
```

## License

MIT — 见 [LICENSE](../LICENSE)。
