# ds-forge

Lightweight agent harness for DeepSeek V4. Thin wrapper around the OpenAI-compatible API with context management, tool calling, and session persistence.

## Install

```bash
npm install
```

Set your key:

```bash
export DEEPSEEK_API_KEY=sk-...
```

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
  model?: string;        // default: "deepseek-chat"
  system?: string;       // system prompt
  tools?: Tool[];        // registered tools
  maxTokens?: number;    // default: 128_000
  baseURL?: string;      // default: "https://api.deepseek.com/v1"
});
```

**Methods:**

| Method | Description |
|---|---|
| `chat(message, extra?)` | Single turn. Returns text, tool calls rendered as JSON. |
| `run(message?, maxTurns?, extra?)` | Agent loop. Auto-executes tools, feeds results back. Stops when the model is done or `maxTurns` (default 10) is reached. |
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

A `Tool` also has `toOpenAISpec()` which returns the OpenAI-compatible function spec.

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
  "version": "0.2.0",
  "model": "deepseek-chat",
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

## Running the demo

```bash
# load .env into the shell (or: npm run demo uses --env-file-if-exists)
set -a; source .env; set +a
npm run demo
npm run demo:mcp    # MCP playground (agent loop needs DEEPSEEK_API_KEY)
npm run test:mcp    # MCP tests, no API key
```

## License

MIT — see [LICENSE](LICENSE).
