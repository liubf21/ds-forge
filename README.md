# ds-forge

[中文文档](docs/README.zh-CN.md)

Lightweight agent harness for DeepSeek V4. Thin wrapper around the OpenAI-compatible API with context management, tool calling, and session persistence.

## Install

```bash
npm install
cp .env.example .env   # add your key
```

`npm run demo` / `demo:mcp` load `.env` automatically (`tsx --env-file-if-exists`). To run examples directly: `npx tsx --env-file=.env examples/...`

## Quick start

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

Main harness — wires together the API client, context, and tools.

```typescript
const forge = new Forge({
  apiKey?: string;       // default: process.env.DEEPSEEK_API_KEY
  model?: string;        // default: "deepseek-v4-flash"
  reasoningEffort?: "high" | "max" | "off";  // default: "high" with tools, "off" without
  system?: string;       // system prompt
  tools?: Tool[];        // registered tools
  maxTokens?: number;    // default: 128_000
  baseURL?: string;      // default: "https://api.deepseek.com/v1"
});
```

DeepSeek's official examples use `https://api.deepseek.com` as `base_url`. The current default keeps the OpenAI-style `/v1` path for SDK compatibility; override `baseURL` if your gateway expects the official root URL.

**Methods:**

| Method | Description |
|---|---|
| `chat(message, extra?)` | Single turn. Returns text, tool calls rendered as JSON. |
| `run(message?, maxTurns?, extra?)` | Agent loop. Auto-executes tools, feeds results back. Stops when the model is done or `maxTurns` (default 10) is reached. |
| `runStream(message?, maxTurns?, extra?)` | Same as `run`, but yields `StreamEvent` chunks (text deltas, tool calls, results). |
| `resume(message?, maxTurns?, extra?)` | Alias for `run` — semantic clarity for loaded sessions. |
| `save(path)` | Persist conversation to a JSON file. |
| `Forge.load(path, config?)` | Reconstruct from a saved session. Tools must be re-provided (callables can't be serialized). |
| `Forge.debug(path, config?)` | Stateless replay. Loads messages from a JSON file (raw list or session), sends one API call, returns `{ role, content, tool_calls }`. No agent loop, no side effects. |

### `tool()`

Factory that creates a `Tool` from a definition object.

```typescript
const myTool = tool({
  name: string;           // must match ^[a-zA-Z0-9_-]+$
  description: string;    // shown to the model
  parameters: JsonSchema; // JSON Schema for arguments
  execute: (args: Record<string, unknown>) => string | Promise<string>;
});
```

Use `ToolRegistry.toOpenAISpecs()` when you need OpenAI-format tool specs (e.g. custom API calls).

### `ToolRegistry`

Collection of tools with lookup and batch serialization.

```typescript
const reg = new ToolRegistry();
reg.register(myTool);
reg.has("myTool");              // boolean
reg.get("myTool");              // Tool | undefined
await reg.execute("myTool", { key: "value" });
reg.toOpenAISpecs();           // OpenAI-format tool specs
```

Errors during execution are caught and returned as strings — the model can self-correct.

### `Context`

Ordered message list with token estimation and auto-truncation.

```typescript
const ctx = new Context();
ctx.addSystem("You are helpful.");
ctx.addUser("Hello!");
ctx.addAssistant("Hi!");
ctx.addToolResult("call_1", "result", "toolName");
ctx.tokenCount();       // char/4 heuristic, pluggable via ctx.tokenCounter
ctx.truncate();          // FIFO eviction, preserves system message
ctx.toList();            // OpenAI-format message dicts
ctx.clear();
Context.fromDicts(dicts); // reconstruct from raw dicts
```

### `Session`

Serializable conversation snapshot. Stores messages and tool schemas — **not** callables.

```typescript
Session.fromForge(forge);     // snapshot
session.save("path.json");
const s = Session.load("path.json");
s.validateTools(registry);    // check tool names match registered callables
```

**JSON format:**

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

Optional preset for coding agents — wraps `Forge` with default system prompt, bash tool, and trajectory persistence. Used by `npm run tui` and `examples/agent.ts`.

```typescript
const session = AgentSession.open({ cwd: "/my/project", resume: "trajectories/task.json" });
await session.forge.run("list files in src/");
session.save();                          // writes to session.trajPath
session.clear();                         // new trajectory + reset context
```

**System prompt:** default lives in `src/system.ts` (`codingAgentSystem`). Override at open time with `system: "..."`. `--resume` uses the prompt stored in the trajectory; pass `system:` with `--resume` to replace it immediately via `context.addSystem()`.

```typescript
AgentSession.open({ cwd, system: "You are a security reviewer." });
```

### `bashTool`

Full shell access via `child_process.exec` — **not sandboxed**. Options: `cwd`, `timeout`, `maxOutput`. No command allowlist; see DESIGN.md §7. For constrained environments, register structured tools instead of patching bash.

```typescript
import { bashTool } from "ds-forge";

forge.tools.register(bashTool({ cwd: "/my/project", timeout: 60_000 }));
```

## Patterns

### Tool with validation

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

### Custom token counter

```typescript
import { Context } from "ds-forge";

const ctx = new Context();
ctx.tokenCounter = (msgs) => {
  // plug in tiktoken or any estimator
  return msgs.reduce((n, m) => n + JSON.stringify(m).length, 0) / 4;
};
```

### Debug workflow

```bash
# 1. Save a session
forge.save("debug.json");

# 2. Edit messages manually in debug.json

# 3. Replay
npx tsx -e "
  import { Forge } from './src/index.js';
  const msg = await Forge.debug('debug.json');
  console.log(msg);
"
```

### Load & resume

```typescript
const forge = Forge.load("session.json", { tools: [getWeather, calculate] });
await forge.resume("Now check Tokyo too.");
```

## Agent TUI

Interactive terminal chat (Claude Code style) with streaming, bash tool, and automatic trajectory persistence.

```bash
npm run tui                                          # new session
npm run tui -- --cwd /path/to/project                # set working directory
npm run tui -- --resume trajectories/task-xxx.json   # continue a saved session
```

The extra `--` is required by npm: everything after it is passed to the script, not interpreted by npm itself. To skip it, run directly:

```bash
npx tsx --env-file-if-exists=.env tui/index.tsx --resume trajectories/task-xxx.json
```

**CLI flags:** `--cwd`, `--resume <path>`, `--model`, `--max-turns`

**In-session commands:** `/clear` (new trajectory), `/quit`, Ctrl+C

**Trajectories:** saved to `./trajectories/` by default (override with `DS_FORGE_DIR`). A new `task-<timestamp>.json` is created on start; the file is updated after each turn and on exit. The header shows the current filename.

See also `examples/agent.ts` for a non-interactive CLI with the same persistence model.

## Running the demo

```bash
npm run demo        # needs DEEPSEEK_API_KEY in .env
npm run demo:mcp    # MCP playground
npm run test        # no API key (MCP + TUI)
npm run tui         # Agent TUI (terminal chat)
```

## Further reading

| Doc | Description |
|---|---|
| [DESIGN.md](DESIGN.md) | Architecture and design trade-offs |
| [docs/README.zh-CN.md](docs/README.zh-CN.md) | Getting started (Chinese) |
| [docs/deepseek-v4.md](docs/deepseek-v4.md) | DeepSeek V4 architecture, API, agent semantics (Chinese) |
| [docs/DESIGN.zh-CN.md](docs/DESIGN.zh-CN.md) | Architecture (Chinese) |
| [docs/mcp.md](docs/mcp.md) | MCP protocol (Chinese) |
| [docs/llm-protocols.md](docs/llm-protocols.md) | LLM API protocol comparison (Chinese) |

## License

MIT — see [LICENSE](LICENSE).
