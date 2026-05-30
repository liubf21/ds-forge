# chat() / run() 重复分析与改法（2026-05-31）

## 重复在哪

| 步骤 | `_send()` (chat) | `run()` loop |
|---|---|---|
| truncate | ✅ | ✅ |
| toOpenAISpecs | ✅ | ✅ |
| completions.create | ✅ | ✅ |
| tool_calls → ToolCall[] | ✅ | ✅ |
| addAssistant | ✅ | ✅ |
| execute tools | ❌ 返回 JSON | ✅ continue |
| 无 tool_calls 时 return text | ✅ | ✅ |

约 30 行逻辑双份；`Forge.debug()` 还有第三份（create + map tool_calls）。

## 为什么会这样

1. **语义分叉**：`chat()` 遇 tool_calls **不执行**，把 JSON 还给调用方（UI 层自己决定）；`run()` **必须执行**并 continue。作者先抽了 `_send()` 服务 chat，写 run 时没有复用它。
2. **控制流不同**：chat 是 single-shot exit；run 是 loop + tool result 回灌。一眼看不像「同一个函数包一层 for」。
3. **刻意保持 flat**：thin wire 项目常见「先写通再抽象」；128 行 orchestrator 里 duplication 可接受。
4. **不是 bug**：两条路径行为经 DESIGN 文档约定，重复是 maintainability 问题不是 correctness 问题。

## 推荐改法：抽 `_callModel` + `_executeToolCalls`

原则：**只抽「相同的部分」**，分叉留在 public API。

```typescript
/** 一次 API 往返：truncate → create → 规范化 assistant 消息 */
private async _callModel(extra?: Record<string, unknown>): Promise<{
  content: string | null;
  toolCalls: ToolCall[] | null;
}> {
  this.context.truncate();
  const toolSpecs = this.tools.toOpenAISpecs();
  const tools = toolSpecs.length > 0 ? toolSpecs : undefined;

  const response = await this.client.chat.completions.create({
    model: this.model,
    messages: this.context.toList() as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    tools,
    ...extra,
  });

  const msg = response.choices[0]!.message;
  const toolCalls = msg.tool_calls?.length
    ? msg.tool_calls.map((tc): ToolCall => ({ /* 现有 map */ }))
    : null;

  return { content: msg.content, toolCalls };
}

private async _executeToolCalls(toolCalls: ToolCall[]): Promise<void> {
  for (const tc of toolCalls) {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(tc.function.arguments);
    } catch {
      this.context.addToolResult(tc.id, `Error parsing tool arguments: ${tc.function.arguments}`, tc.function.name);
      continue;
    }
    const result = await this.tools.execute(tc.function.name, args);
    this.context.addToolResult(tc.id, result, tc.function.name);
  }
}
```

然后：

```typescript
async chat(message: string, extra?) {
  this.context.addUser(message);
  const { content, toolCalls } = await this._callModel(extra);
  if (toolCalls) {
    this.context.addAssistant(content, toolCalls);
    return JSON.stringify(toolCalls, null, 2);
  }
  this.context.addAssistant(content);
  return content || "";
}

async run(message?, maxTurns?, extra?) {
  if (message) this.context.addUser(message);
  for (let turn = 0; turn < maxTurns; turn++) {
    const { content, toolCalls } = await this._callModel(extra);
    if (toolCalls) {
      this.context.addAssistant(content, toolCalls);
      await this._executeToolCalls(toolCalls);
      continue;
    }
    this.context.addAssistant(content);
    return content || "";
  }
  return "[Max turns reached]";
}
```

## 不建议的改法

- **`run()` 内部直接调 `_send()`**：tool_calls 时 `_send` 已 return JSON，无法进入 execute 分支。
- **把 chat 改成 run(maxTurns=1) 的特殊 case**：tool_calls 语义仍不同（JSON vs execute），会藏 bug。
- **过度抽象 AgentStep / TurnResult 类型**：对这个体量是 over-engineering。

## debug() 是否一起抽

可选第四层 `_mapToolCalls(rawMsg)` 或让 debug 复用 `_callModel` 的 map 逻辑。优先级低于 chat/run，因为 debug 是无实例静态方法、故意不碰 Context。

## 与 streaming 的关系

将来 `runStream()` 应单独 `_callModelStream()`；同步路径的 `_callModel` 仍保留，避免 stream/non-stream 耦在一个函数里。

## 优雅度评估（2026-05-31）

**结论：`_callModel` + `_executeToolCalls` 对此 repo 已足够优雅（~8/10）；再往上抽 `_step` 可至 ~9/10。**

| 层级 | 评价 |
|---|---|
| `_callModel` + `_executeToolCalls` | ✅ 合适：职责清晰，public API 不变，无新类型 |
| 再加 `_step`（call + addAssistant，返回 toolCalls \| null） | ✅ 更优：`addAssistant` 也只剩一处 |
| `StepResult` 联合类型 / strategy / middleware | ❌ over-engineering |
| `run` 复用 `_send` | ❌ 语义错误 |

**不够优雅之处（可接受）：** `debug()` 仍独立一份 map；`last()?.content` 作返回值略隐式；无 streaming 时已是局部最优。

## 已落地（2026-05-31）

- `mapToolCalls()` — module-level，chat/run/debug 共用
- `_callModel()` — truncate + API + 解析
- `_step()` — call + addAssistant，返回 toolCalls | null
- `_executeToolCalls()` — parse + execute + addToolResult
- `chat()` / `run()` 各 ~6 行，删除 `_send()`
- `npm run build`（tsc）通过
