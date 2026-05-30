# ds-forge Design

[中文](docs/DESIGN.zh-CN.md)

## Philosophy

A good agent harness should be a **thin wire, not a framework**. It connects three things — a model, a message history, and a set of tools — without imposing opinions about prompt structure, tool semantics, or control flow. DeepSeek V4's API is OpenAI-compatible, so the HTTP layer is handled by the `openai` SDK; we only add what's genuinely needed above it.

Three constraints drove every decision:
1. **Minimal surface area** — one class (`Forge`), one factory (`tool()`), one job (wire model ↔ context ↔ tools)
2. **No magic** — JSON Schema is explicit; types are erased at runtime in TS, so don't pretend otherwise
3. **Debuggable** — every state transition produces serializable artifacts; trajectories are first-class

## Architecture

```
User Code
    │
    ▼
┌─────────────────────────────────┐
│            Forge                 │  Orchestrator
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

## Module Boundaries

Each module has **zero internal dependencies** on other ds-forge modules (except `forge.ts` which wires them all). This means you can use `Context` standalone for token counting, or `ToolRegistry` standalone for schema management.

| Module | Depends on | Role |
|---|---|---|
| `types.ts` | nothing | Shared interfaces, no logic |
| `tools.ts` | types.ts | `tool()` factory + `ToolRegistry` |
| `context.ts` | types.ts | Message list, token count, truncation |
| `bash.ts` | tools.ts | Pre-built bash execution tool |
| `session.ts` | types.ts, context.ts, forge.ts (type only) | JSON serialization |
| `forge.ts` | all above | Orchestrator — the only module with cross-cutting concerns |

## Key Design Decisions

### 1. Tool callables are NOT serialized

`Session` stores tool **schemas** (name, description, parameters) but never the `execute` function. This is deliberate:
- Python functions can't be meaningfully serialized with stdlib
- Tool implementations may change between sessions
- On `Forge.load()`, the user re-provides tools; `validateTools()` checks that names match, and warns if they don't

Mismatched tools don't block loading — you might intentionally replay messages without tool execution.

### 2. JSON Schema is explicit, not derived

Python's `@tool` decorator used `inspect` to generate JSON Schema from type hints. TypeScript types are erased at runtime, so the equivalent doesn't exist. We chose explicit JSON Schema over Zod:
- Zero dependencies
- Compatible with any schema generator the user prefers
- No hidden mapping between TS types and JSON Schema types

If the user wants Zod, they can add it trivially:
```typescript
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

const schema = zodToJsonSchema(z.object({ city: z.string() }));
```

### 3. Token counting is heuristic and pluggable

Default: `JSON.stringify(messages).length / 4`. This is ~15% accurate for English text but costs zero dependencies. The `Context.tokenCounter` field is assignable — swap in `tiktoken` or any estimator:
```typescript
ctx.tokenCounter = (msgs) => myAccurateCounter(msgs);
```

### 4. Tool errors self-correct

When a tool call fails (JSON parse error, execution exception, unknown tool name), the error string is fed back to the model as the tool result. The model sees it and can retry with corrected arguments. No special error channel, no exception propagation — just text in, text out.

### 5. Debug is stateless

`Forge.debug()` creates a **transient** OpenAI client, sends messages, returns the raw response, and exits. It never creates a Forge instance, never modifies files, never enters an agent loop. This separation means:
- Debug can't accidentally mutate state
- It works with raw message lists OR session files (auto-detects)
- The return type is `{ role, content, tool_calls }` — full inspection, not just text

### 6. Truncation is FIFO, system-preserving

Before every API call, `truncate()` removes the oldest non-system message until the estimated token count fits `maxTokens`. If even the system message alone exceeds the limit, its content is truncated. This is crude but sufficient — the 128K context window of deepseek-chat means truncation rarely triggers in practice.

## Data Flow

### Single turn (`chat`)
```
User → forge.chat("Hi")
  → context.addUser("Hi")
  → _send()
    → context.truncate()
    → client.chat.completions.create(messages, tools?)
    → if tool_calls: context.addAssistant(tool_calls), return JSON
    → else: context.addAssistant(content), return text
```

### Agent loop (`run`)
```
User → forge.run("Task", maxTurns=10)
  → context.addUser("Task")
  → for turn in 0..maxTurns:
    → context.truncate()
    → client.chat.completions.create(messages, tools)
    → if no tool_calls: break, return content
    → context.addAssistant(tool_calls)
    → for each tool_call:
      → json.parse(arguments)
      → registry.execute(name, args)
      → context.addToolResult(id, result, name)
  → return "[Max turns reached]" if loop exhausted
```

### Persistence roundtrip
```
forge.save("s.json")
  → Session.fromForge(forge)      // snapshots model, system, messages, tool specs
  → JSON.stringify → writeFile

Forge.load("s.json", { tools })
  → Session.load("s.json")        // parse JSON
  → new Forge({ model, system, tools })
  → forge.context = Context.fromDicts(session.messages)
  → validateTools(registry)        // warn if mismatched
```

## Conventions

- **Messages are append-only** during a run. The only mutation is `truncate()` (FIFO eviction) and `addSystem()` (replace).
- **System prompt sits at index 0** and is never evicted by truncation. Use `addSystem()` to replace it.
- **Tool call IDs** are generated by the API. We pass them through verbatim in `addToolResult()`.
- **`chat()` vs `run()`**: `chat()` is single-turn — tool calls come back as JSON text. `run()` is multi-turn — tool calls are auto-executed. Use `chat()` for UIs, `run()` for autonomous agents.

## Trade-offs

| Choice | Benefit | Cost |
|---|---|---|
| `openai` SDK as HTTP layer | Retries, streaming, error handling for free | Extra dependency (but unavoidable) |
| No pydantic/Zod for schemas | Zero magic, minimal deps | Verbose parameter definitions |
| char/4 token counting | Zero deps, fast | ~15% accuracy for non-English |
| Explicit JSON Schema | Portable, debuggable | No type-safety between schema and execute |
| Tool callables not serialized | Clean separation of code/data | Must re-provide tools on load |
