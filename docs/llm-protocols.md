# LLM API 协议对比

[文档索引](README.zh-CN.md)

OpenAI Chat Completions、OpenAI Responses、Anthropic Messages、Google Gemini 四种 API 在 tool calling 上的格式差异与设计思路。

## 目录

1. [全景对比](#1-全景对比)
2. [OpenAI Chat Completions](#2-openai-chat-completions)
3. [OpenAI Responses](#3-openai-responses)
4. [Anthropic Messages](#4-anthropic-messages)
5. [Google Gemini](#5-google-gemini)
6. [设计取舍](#6-设计取舍)

---

## 1. 全景对比

四种 API 都遵循同一个 Agent Loop 模式（模型输出调用意图 → 执行工具 → 返回结果 → 继续推理），但格式和语义各有不同：


|               | OpenAI Chat                             | OpenAI Responses                                    | Anthropic                                    | Gemini                                 |
| ------------- | --------------------------------------- | --------------------------------------------------- | -------------------------------------------- | -------------------------------------- |
| **工具声明**      | `tools[].function` 嵌套                   | `tools[]` 扁平                                        | `tools[]` 扁平                                 | `tools[].functionDeclarations[]` 嵌套    |
| **参数 Schema** | `function.parameters`                   | `parameters`                                        | `input_schema`                               | `parameters`                           |
| **工具调用 ID**   | `tool_calls[].id` (字符串)                 | `call_id` (字符串)                                     | `id` (字符串)                                   | 早期无 ID；3.x 起 `functionCall.id`         |
| **调用表示**      | `message.tool_calls[]`                  | `output[]` 中的 `function_call`                       | `content[]` 中的 `tool_use` block              | `parts[]` 中的 `functionCall`            |
| **结果回传**      | `role: "tool"`                          | `type: "function_call_output"`                      | `type: "tool_result"` (放在 user role 里)       | `role: "function"`                     |
| **结束条件**      | `finish_reason: "tool_calls"`           | `status: "completed"`（查 output）                     | `stop_reason: "tool_use"`                    | `finishReason: "STOP"`（查 functionCall） |
| **并行调用**      | 一个 message 含多个 `tool_calls`             | 一个 output 含多个 `function_call`                       | 一个 message 含多个 `tool_use`                    | 一个 parts 含多个 `functionCall`            |
| **工具选择**      | `tool_choice: "auto"/"required"/"none"` | `tool_choice: "auto"/"required"/"none"`             | `tool_choice: { type: "auto"/"any"/"tool" }` | `tool_config.function_calling_config`  |
| **内置工具**      | 无                                       | web_search, file_search, code_interpreter, computer | computer_use                                 | google_search, code_execution          |
| **推理/思考**     | `reasoning_effort` (仅 o 系列)             | `reasoning` 参数                                      | `thinking: { type, budget_tokens }`          | `thinking_config: { thinking_budget }` |


---

## 2. OpenAI Chat Completions

> 参考文档：[Chat Completions API](https://platform.openai.com/docs/api-reference/chat) · [Tool Calling Guide](https://platform.openai.com/docs/guides/function-calling)

事实标准，几乎所有非 OpenAI 的 API（DeepSeek、Qwen、Groq 等）都兼容此格式。

**设计理念**：实用主义增量。Chat API 最初只是 Completion 的变体——把 `/completions` 的 `prompt` 换成 `messages` 数组就变成了对话。Tool calling 是后来拼上去的：`tools`、`tool_calls`、`role: "tool"`，每一个都是新概念，不是从原有模型里自然推导出来的。它不优雅，但胜在**简单粗暴**——会 HTTP 请求就能接入，也因此成了行业的事实标准。

### 工具声明

```jsonc
// POST /v1/chat/completions
{
  "model": "gpt-4o",
  "messages": [{"role": "user", "content": "旧金山今天几度？"}],
  "tools": [{
    "type": "function",                    // 目前只有 function
    "function": {                          // ← 额外嵌套层
      "name": "get_weather",
      "description": "查询某城市当前气温",
      "parameters": {                      // JSON Schema
        "type": "object",
        "properties": {
          "city": { "type": "string", "description": "城市名" }
        },
        "required": ["city"]
      }
    }
  }]
}
```

### 工具调用（响应）

```jsonc
{
  "choices": [{
    "index": 0,
    "finish_reason": "tool_calls",        // ← 区分：需要执行工具
    "message": {
      "role": "assistant",
      "content": null,                     // 调用工具时 content 为 null
      "tool_calls": [{
        "id": "call_abc123",               // 唯一 ID
        "type": "function",
        "function": {
          "name": "get_weather",
          "arguments": "{\"city\":\"SF\"}" // JSON 字符串，需手动 parse
        }
      }]
    }
  }]
}
```

### 结果回传

```jsonc
// 追加到 messages 数组，继续下一轮请求
{
  "role": "tool",                          // ← 独立 role
  "tool_call_id": "call_abc123",           // 通过 ID 匹配
  "content": "旧金山 15°C，多云"            // 纯文本
}
```

### 流式

```text
delta: {"tool_calls":[{"index":0,"id":"call_","function":{"name":"","arguments":""}}]}
delta: {"tool_calls":[{"index":0,"id":null,"function":{"name":"get_","arguments":""}}]}
delta: {"tool_calls":[{"index":0,"id":null,"function":{"name":"weather","arguments":"{\""}}]}
delta: {"tool_calls":[{"index":0,"id":null,"function":{"name":null,"arguments":"city"}}]}
...
```

流式下 `arguments` 是增量片段，客户端需要按 `index` 拼接。

---

## 3. OpenAI Responses

> 参考文档：[Responses API](https://platform.openai.com/docs/api-reference/responses) · [Responses Guide](https://platform.openai.com/docs/guides/responses)

2025 年推出的新 API，统一了 Chat Completions + Assistants API。核心变化：**有状态**、**去掉嵌套**、**内置工具**。

### 为什么推出 Responses 而不是继续改进 Chat？

Chat Completions 的问题在于**概念膨胀**。随着功能叠加，API 变成了杂物抽屉：

```
Chat Completions 同时承载：
  - 对话补全 (messages)
  - 工具调用 (tools, tool_calls, role: "tool")
  - 结构化输出 (response_format: json_schema)
  - 流式 (stream: true)
  - Vision (content 可以是 type: "image_url" 数组)
  - 函数调用 (functions 字段 — 已废弃)
  - 并行调用 (多个 tool_calls 在一次响应中)
```

同时，Assistants API 是另一套独立的接口——有状态、带 RAG + Code Interpreter + File Search。两套 API，两套 SDK，功能互相重叠但无法互通。

Responses 的答案：**一个 API 承载所有交互形态**。

`input` / `output` 模型比 `messages` 更通用——`function_call`、`web_search_call`、`file_search_call` 都只是 output 数组里的不同 `type`，不需要为每种新能力发明新的 role 或字段。有状态设计（`previous_response_id`）把历史存储和截断交给服务端，让 OpenAI 可以做服务端上下文缓存优化。

**设计理念**：**大一统**。Chat + Assistants → 一个 API。工具、搜索、文件、代码执行——都是 `output[]` 中的一等公民。类型系统取代角色枚举。代价是引入了服务端状态，比无状态的 Chat 少了控制力。

### 关键差异

```
Chat Completions              Responses
─────────────────────────────────────────────────
无状态（每次传入全部 history）  有状态（previous_response_id）
tools[].function 嵌套           tools[] 扁平
messages 数组                  input 数组 + output 数组
role: "tool"                   type: "function_call_output"
web search 需要外部集成         web_search 内置
```

### 工具声明

```jsonc
// POST /v1/responses
{
  "model": "gpt-4o",
  "input": [{"role": "user", "content": "旧金山今天几度？"}],
  "tools": [{
    "type": "function",                    // function / web_search / file_search / code_interpreter / computer
    "name": "get_weather",                 // 没有 function 嵌套层
    "description": "查询某城市当前气温",
    "parameters": {
      "type": "object",
      "properties": {
        "city": { "type": "string" }
      },
      "required": ["city"]
    }
  }]
}
```

### 工具调用（响应）

```jsonc
{
  "id": "resp_abc123",
  "status": "completed",                   // ← 即使要调用工具，status 仍是 completed
  "output": [                              // 遍历 output 找 type:"function_call"
    {
      "type": "function_call",             // 可以是 function_call / message 等
      "id": "fc_123",
      "call_id": "call_abc123",
      "name": "get_weather",
      "arguments": "{\"city\":\"SF\"}"
    }
  ]
}
```

### 结果回传

```jsonc
// POST /v1/responses (带 previous_response_id)
{
  "model": "gpt-4o",
  "previous_response_id": "resp_abc123",   // 状态链
  "input": [{
    "type": "function_call_output",        // ← 不是 role，是 type
    "call_id": "call_abc123",
    "output": "旧金山 15°C，多云"            // 字段名是 output 不是 content
  }]
}
```

### Chat vs Responses：什么时候用哪个


| 场景                               | 推荐               |
| -------------------------------- | ---------------- |
| 兼容 DeepSeek / 第三方 API            | Chat Completions |
| 需要 web_search / file_search 内置工具 | Responses        |
| 多轮对话、需要服务端管理状态                   | Responses        |
| 流式 tool calling、fine-tuned 模型    | Chat Completions |
| 简单文本补全、日常对话                      | Chat Completions |
| Assistants API 替代                | Responses        |


---

## 4. Anthropic Messages

> 参考文档：[Messages API](https://docs.anthropic.com/en/api/messages) · [Tool Use Guide](https://docs.anthropic.com/en/docs/build-with-claude/tool-use)

Claude 的 API 在概念上最干净：**content 是类型化的数组**，每种 block 有明确的 `type`。没有 `role: "tool"` 这种独立角色——tool result 作为 user message 的一部分回传。

**设计理念**：**概念极简主义**。Anthropic 的立场是——API 应该忠实地反映信息流，而不是为每种新交互发明新的抽象层。`tool_use` 放在 content 数组里，因为"调用工具"就是模型输出的内容，和 `text` block 平等。`tool_result` 放在 user role 里，因为"工具结果"就是外部输入——模型不应该区分"用户说了什么"和"工具返回了什么"，两者都是它需要理解的信息。`input` 直接是 JSON 对象而非字符串——因为工具的输入本身是结构化数据，客户端和模型都不应该处理一坨需要二次解析的文本。这套设计让 API surface 更小，概念更少，但要求开发者接受"content 是异质数组"这个心智模型。

### 工具声明

```jsonc
// POST /v1/messages
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 1024,
  "messages": [{"role": "user", "content": "旧金山今天几度？"}],
  "tools": [{
    "name": "get_weather",
    "description": "查询某城市当前气温",
    "input_schema": {                      // 字段名是 input_schema，不是 parameters
      "type": "object",
      "properties": {
        "city": { "type": "string" }
      },
      "required": ["city"]
    }
  }]
}
```

### 工具调用（响应）

```jsonc
{
  "id": "msg_abc123",
  "stop_reason": "tool_use",               // ← 区分：需要执行工具
  "content": [                             // content 永远是数组，每项有 type
    {
      "type": "text",
      "text": "让我查一下旧金山的天气。"
    },
    {
      "type": "tool_use",                  // ← 和 text block 同级
      "id": "toolu_abc123",
      "name": "get_weather",
      "input": {                           // 已解析的 JSON 对象，不是字符串
        "city": "SF"
      }
    }
  ]
}
```

**两个关键差异**：

1. `**input` 是对象不是字符串**——无需 `JSON.parse()`，API 直接返回解析好的 JSON
2. **tool_use 可以和 text 共存**——Claude 可以先说一段话再调用工具，OpenAI 的 `tool_calls` 和 `content` 互斥

### 结果回传

```jsonc
// tool result 放在 user message 的 content 数组里
{
  "role": "user",                          // ← 注意是 user，不是 tool
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "toolu_abc123",
      "content": [                         // content 也可以是数组
        { "type": "text", "text": "旧金山 15°C，多云" }
      ]
    }
  ]
}
```

### tool_choice 选项

```jsonc
// 比 OpenAI 更精细
"tool_choice": { "type": "auto" }          // 默认，模型自行决定
"tool_choice": { "type": "any" }           // 必须调用任意一个工具
"tool_choice": { "type": "tool", "name": "get_weather" }  // 必须调用指定工具
```

### computer_use

Claude 专有：`type: "computer_20241022"` 的 tool 可输出鼠标坐标和截图指令，用于 GUI 自动化。OpenAI 和 Gemini 的浏览器/代码工具是服务端沙箱执行；Claude 的 computer_use 是**输出动作指令**让客户端执行。

---

## 5. Google Gemini

> 参考文档：[Gemini API](https://ai.google.dev/api/generate-content) · [Function Calling Guide](https://ai.google.dev/gemini-api/docs/function-calling)

格式最"Google 味"——嵌套深，但做了工程简化（无调用 ID、自动循环模式）。

**设计理念**：**工程便利优先**。Gemini 走在实用主义的另一端——如果 90% 的场景不需要精确匹配某次调用，那调用 ID 就可以省略。如果大多数开发者会手写 agent loop，那就提供自动循环让 SDK 代劳。`tools[].functionDeclarations[]` 的双层嵌套来自 protobuf 的血统（一个 tool 可以包含多种声明类型，function 只是其一），不是为了复杂而复杂。Google 的策略很明确：宁愿牺牲一些正确性和灵活性，也要把"从注册 API key 到跑通第一个 demo"的时间压缩到最短。

### 工具声明

```jsonc
// POST /v1beta/models/gemini-2.5-flash:generateContent
{
  "contents": [{
    "role": "user",
    "parts": [{ "text": "旧金山今天几度？" }]
  }],
  "tools": [{
    "functionDeclarations": [{              // ← 两层嵌套：tools[].functionDeclarations[]（REST 用驼峰）
      "name": "get_weather",
      "description": "查询某城市当前气温",
      "parameters": {                       // 字段名保持 parameters
        "type": "object",
        "properties": {
          "city": { "type": "string" }
        },
        "required": ["city"]
      }
    }]
  }]
}
```

### 工具调用（响应）

```jsonc
{
  "candidates": [{
    "finishReason": "STOP",                // ← 调用函数时仍是 STOP，靠 parts[].functionCall 判断
    "content": {
      "role": "model",
      "parts": [
        {
          "functionCall": {                  // ← 小驼峰，和其他家的 snake_case 不同
            "name": "get_weather",
            "args": { "city": "SF" }         // 对象而非字符串，和 Anthropic 一样
          }
        }
      ]
    }
  }]
}
```

**早期版本没有调用 ID**——匹配靠 `name`，并行调用同名函数时有歧义（无法区分两次 `get_weather`）。但 **Gemini 3.x 起 `functionCall` 带 `id`**，回传 `functionResponse` 时需带上匹配的 `id`——这个历史短板已被补上。

### 结果回传

```jsonc
// 追加到 contents 数组
{
  "role": "function",                      // ← 独立 role: "function"（也接受 role: "user"）
  "parts": [{
    "functionResponse": {
      "id": "...",                         // 3.x：需与 functionCall.id 匹配（早期版本无此字段）
      "name": "get_weather",               // 仍需带 name
      "response": { "temperature": 15 }    // 可以是任意 JSON
    }
  }]
}
```

### 自动函数调用模式

Gemini 可以在 SDK 层配置自动循环——不需要手写 agent loop：

```python
# Gemini 帮你自动循环直到 stop_reason 不是 function_call
from google import genai
client = genai.Client()
client.models.generate_content(
    automatic_function_calling={"enabled": True}
)
```

折衷：方便，但丢失了对中间步骤的控制权。

---

## 6. 设计取舍

### 调用 ID vs 按 name 匹配

```
OpenAI / Anthropic:  tool_call_id 精确匹配
Gemini (早期):       按 function name 匹配
Gemini (3.x):        functionCall.id —— 已补上 ID
```

ID 匹配是更正确的设计——结果应精确对应到某一次调用。Gemini 早期省略 ID，并行调用同名函数时无法区分顺序；**3.x 起已加入 `id`**，向 OpenAI/Anthropic 的精确匹配靠拢。这条"按 name 匹配"的旧设计取舍，如今基本只剩历史意义。

### content 序列化方式

```
OpenAI: arguments 是 JSON 字符串，需手动 JSON.parse
Anthropic / Gemini: input/args 已是解析好的对象

选择：字符串方式更兼容流式（可以逐片段吐出），对象方式更方便使用
```

OpenAI 的字符串策略是工程折衷——流式模式下 `arguments` 是增量片段，客户端不知道最终 JSON 长什么样，没法提前解析。Anthropic 也支持流式 tool use，但它通过 content block 级别的增量解决这个问题。

### 独立 role vs content block

```
OpenAI:  role="tool" 是独立的顶层类型
Anthropic: tool_result 是 user message content 的一项
Gemini:   role="function" 是独立的顶层类型

哲学差异：
- OpenAI/Gemini 认为 tool result 是不同于 user/assistant 的消息类型
- Anthropic 认为 tool result 就是 user 拿回来的信息，归入 user role
```

Anthropic 的方案更反映了真实的信息流——工具结果是外部系统返回给 agent 的，本质上是"用户侧"的输入。但这也意味着你无法在 messages 数组里直接区分"用户说了什么"和"工具返回了什么"——需要遍历 content blocks。

### 有状态 vs 无状态

```
Chat Completions / Anthropic: 无状态，客户端每次传入完整的 messages[]
Responses:                    有状态，通过 previous_response_id 链式调用

影响：
- 无状态：可中途修改 history、支持复杂分支逻辑
- 有状态：服务端可做 context 管理优化，但客户端失去灵活性
```

Responses API 的有状态设计适合简单场景（一问一答 + 工具调用），但遇到需要手动修改 history 的高级场景时反而麻烦。

### 内置工具策略


|        | OpenAI                           | Anthropic             | Gemini           |
| ------ | -------------------------------- | --------------------- | ---------------- |
| Web 搜索 | Responses API `web_search`       | 无                     | `google_search`  |
| 文件检索   | Responses API `file_search`      | 无                     | 无                |
| 代码执行   | Responses API `code_interpreter` | 无                     | `code_execution` |
| 电脑操作   | Responses API `computer`（客户端执行）  | `computer_use`（客户端执行） | 无                |


两种执行模型：web 搜索 / 代码执行 / 文件检索由**服务端沙箱**跑（OpenAI、Gemini，黑盒，结果直接回来）；而**操作电脑 / GUI** 这类，OpenAI（`computer`）和 Anthropic（`computer_use`）**都是模型输出动作指令、由你的客户端执行**（白盒，适用面广但集成成本高）。所以"只有 Anthropic 让客户端执行"的说法不成立——OpenAI 的 computer use 是同一种模型。

### 设计理念总结

四种 API 的差异不是随机的——它们反映各家公司对"好的 LLM API"的不同回答：


| 公司                 | 核心偏好          | 终极目标         |
| ------------------ | ------------- | ------------ |
| OpenAI (Chat)      | 兼容性第一，简单优先于优雅 | 降低接入门槛，让生态铺开 |
| OpenAI (Responses) | 统一抽象，减少概念数量   | 一个 API 做所有事  |
| Anthropic          | 类型安全，信息流正确性   | 概念干净，没有 hack |
| Google             | 上手速度，自动化      | 零配置出结果       |


**实践建议**：

- 做 Agent 框架 → 参考 **Anthropic** 的 content block 模型——类型化数组比 role-string 扩展性更好
- 对接多个 LLM 提供商 → 以 **OpenAI Chat** 为基准做归一化——它是生态的最大公约数
- 快速验证想法 → **Gemini** 的自动循环模式开销最小
- 需要 chat + web search + code execution + RAG 一站式 → **Responses** 是最佳选择

---

## 7. 推理/思考与工具调用的交互

2024-2025 年各 API 先后引入 extended thinking（推理/思考）——模型在输出最终回复前，先生成一段内部推理链。这个能力对 tool calling 有直接影响：**模型可以在工具调用之间插入思考步骤**，这对复杂的多步 Agent 任务至关重要。

### 全景


|                   | OpenAI Chat (o 系列)         | OpenAI Responses                 | Anthropic                           | Gemini                                 |
| ----------------- | -------------------------- | -------------------------------- | ----------------------------------- | -------------------------------------- |
| **参数**            | `reasoning_effort`         | `reasoning: { effort }`          | `thinking: { type, budget_tokens }` | `thinking_config: { thinking_budget }` |
| **思考内容位置**        | 不返回（仅计 `reasoning_tokens`） | `output[]` 中 `type: "reasoning"` | `content[]` 中 `type: "thinking"`    | `parts[]` 中 `thought`                  |
| **和 tool_use 交织** | 否（思考 → 一次性调用）              | 否（思考 → 一次性调用）                    | **是**（思考 ↔ 工具交替）                    | 部分支持                                   |
| **需回传**           | 无法回传 → 多工具调用下降级            | 自动保留（同一轮工具循环内）                   | 是（需要原样回传 thinking blocks）           | 是 (`thoughtSignature`)                 |
| **内容签名**          | 无                          | 无                                | 有 (Anthropic 可验证真实性)                | 有 (`thoughtSignature`)                 |
| **计费**            | 独立计 reasoning tokens       | 独立计 reasoning tokens             | 独立计 thinking tokens                 | 独立计                                    |


### Anthropic Extended Thinking：与 tool calling 最深度的集成

Anthropic 的设计最值得细看——thinking 不是独立通道，而是 content 数组中的一等公民：

```jsonc
// 请求
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 4096,
  "thinking": {
    "type": "enabled",
    "budget_tokens": 2000           // thinking 的 token 预算
  },
  "tools": [{ "name": "get_weather", ... }],
  "messages": [...]
}

// 响应 —— thinking 和 tool_use 可以在 content 中交替出现
{
  "stop_reason": "tool_use",
  "content": [
    {
      "type": "thinking",          // ← 第一步思考
      "thinking": "需要先查天气，然后根据温度建议穿什么...",
      "signature": "sig_abc123..."  // 内容签名
    },
    {
      "type": "tool_use",          // ← 调用工具
      "id": "toolu_001",
      "name": "get_weather",
      "input": { "city": "北京" }
    }
  ]
}
```

**之后的回合**：

```jsonc
// 客户端追加 tool_result，并原样回传 thinking block
{
  "role": "user",
  "content": [
    { "type": "tool_result", "tool_use_id": "toolu_001", "content": "北京 32°C" }
  ]
}

// 下一轮 API 调用时，上一个 thinking block 必须仍在 messages 中
// 模型继续思考 → 最终回复
{
  "stop_reason": "end_turn",
  "content": [
    { "type": "thinking", "thinking": "32度很热，建议短袖..." },
    { "type": "text", "text": "北京今天32°C，建议穿短袖..." }
  ]
}
```

关键约束：

- **thinking block 必须在 messages 中原样保留**——删掉或修改会导致 signature 验证失败，模型行为退化
- `**budget_tokens` 是预算不是上限**——模型可能用更少，但超过预算会触发 `redacted_thinking`（内容被截断的标记）
- **thinking 和 tool_use 可以交替**——一次 API 调用中可能看到：think → tool_use → think → tool_use → end_turn，这对需要多步推理后再决定要不要继续调工具的 Agent 场景是质的提升

### OpenAI o 系列：推理对客户端不可见（Chat Completions）

o 系列（o1, o3, o4-mini）的推理是一个**前置阶段**——模型先完成推理再决定调用哪些工具。但在 **Chat Completions** 下，**推理内容对你不可见**：响应里没有任何推理文本，只有 `usage` 里的 `reasoning_tokens` 计数。

```jsonc
// 请求
{
  "model": "o3",
  "messages": [{"role": "user", "content": "北京今天热吗？"}],
  "tools": [{ "type": "function", "function": { "name": "get_weather", ... } }],
  "reasoning_effort": "medium"       // minimal / low / medium / high
}

// 响应 —— 没有推理文本，只有 tool_calls + reasoning_tokens 计数
{
  "choices": [{
    "message": {
      "content": null,
      "tool_calls": [{
        "function": { "name": "get_weather", "arguments": "{\"city\":\"北京\"}" }
      }]
    }
  }],
  "usage": { "completion_tokens_details": { "reasoning_tokens": 512 } }
}
```

和 Anthropic 的关键区别：

- **推理不返回文本**：Chat Completions 只计费 reasoning tokens、不给内容；要拿推理摘要必须用 **Responses API**（`type: "reasoning"` 的 summary）
- **推理丢失 → 有性能代价**：Chat 无状态，reasoning item **永远不会**进入后续上下文。OpenAI 官方明确：在**涉及多次函数调用的复杂 agentic 场景**下，这会导致**性能轻微下降 + reasoning token 消耗增加**——模型每次响应工具结果都得"从头重新推理"。（若不涉及复杂多工具调用，则无差异。）
  > **OpenAI 原文**（[Reasoning best practices](https://developers.openai.com/api/docs/guides/reasoning-best-practices) — *How to keep costs low and accuracy high*）：
  >
  > *If you're using the Chat Completions API, reasoning items are never included in the context of the model. This is because Chat Completions is a stateless API. This will result in **slightly degraded model performance and greater reasoning token usage in complex agentic cases involving many function calls**. In instances where complex multiple function calling is not involved, there should be no degradation in performance regardless of the API being used.*
- **一次性**：不会在 tool call 之间插入推理（对比 Anthropic 的 think ↔ tool 交替）

> **DeepSeek V4 的 reasoning_content**（[Thinking Mode 官方文档](https://api-docs.deepseek.com/guides/thinking_mode)）：
>
> - 响应在 `message.reasoning_content` 返回 CoT 全文（V3 reasoner 起即有，V4 延续）
> - **纯对话、无 tool call**：新 user turn 时中间 assistant 的 `reasoning_content` **不必回传**（传了也会被忽略）
> - **含 tool call 的 agent 场景**：同一 user turn 内及**跨 user turn**，`reasoning_content` **必须回传**，否则 API 返回 400——行为接近 Anthropic thinking blocks / OpenAI Responses reasoning items，与 V3 reasoner「一律不回传」不同
>
> 详见 [deepseek-v4.md § Agent 场景的关键语义](deepseek-v4.md#5-agent-场景的关键语义)。
>
> ```jsonc
> // DeepSeek V4 thinking + tool call 响应
> { "choices": [{ "message": {
>   "reasoning_content": "先查日期再调 weather...",  // 有 tool call 时必须回传
>   "content": null, "tool_calls": [ ... ] } }] }
> ```

### Responses API 的推理

比 Chat 更统一——推理只是 `output[]` 中的一种条目类型：

```jsonc
{
  "output": [
    { "type": "reasoning", "summary": [...] },   // 推理被放在 output 数组（rs_* ID）
    { "type": "function_call", ... }             // 然后是工具调用
  ]
}
```

状态由服务端管理（`store: true` + `previous_response_id`），**reasoning item 会在同一轮的工具调用循环里被保留**——模型响应工具结果时不必重启推理。这正是 Responses 对 reasoning 模型的核心价值（也是上一节 Chat 那条"性能代价"的解药）：

- **官方量级**：同 prompt 同设置，Responses 比 Chat Completions 在 **SWE-bench 上约 +3%**；缓存命中率从 ~40% 提到 ~80%（reasoning token 不重复生成，成本/延迟双降）。
- **ZDR / 无状态**：用 `store: false` + `include: ["reasoning.encrypted_content"]`，拿到加密的 reasoning blob，下一轮**原样回传**——既不落盘又能保住推理链。
- **边界**：保留只发生在**一轮内的 tool-call 循环**（OpenAI 把整个循环算作 "a single turn"）；跨**不同用户轮次**时，上一轮的 reasoning 仍会被丢弃。

> **OpenAI 原文**（Cookbook — *Caching*）：
>
> *In turn 2, any reasoning items from turn 1 are ignored and removed, since the model does not reuse reasoning items from previous turns.*

> **OpenAI 原文**（[Reasoning best practices](https://developers.openai.com/api/docs/guides/reasoning-best-practices) — *How to keep costs low and accuracy high*）：
>
> *With the introduction of `o3` and `o4-mini` models, persisted reasoning items in the Responses API are treated differently. Previously (for `o1`, `o3-mini`, `o1-mini` and `o1-preview`), reasoning items were always ignored in follow‑up API requests, even if they were included in the input items of the requests. With `o3` and `o4-mini`, some reasoning items adjacent to function calls are included in the model's context to help improve model performance while using the least amount of reasoning tokens.*
>
> *For the best results with this change, we recommend using the Responses API with the `store` parameter set to `true`, and passing in all reasoning items from previous requests (either using `previous_response_id`, or by taking all the output items from an older request and passing them in as input items for a new one). OpenAI will automatically include any relevant reasoning items in the model's context and ignore any irrelevant ones. In more advanced use‑cases where you'd like to manage what goes into the model's context more precisely, we recommend that you at least include all reasoning items between the latest function call and the previous user message. **Doing this will ensure that the model doesn't have to restart its reasoning when you respond to a function call, resulting in better function‑calling performance and lower overall token usage.***

> **OpenAI 原文**（[Migrate to the Responses API](https://developers.openai.com/api/docs/guides/migrate-to-responses)）：
>
> *Using reasoning models, like GPT-5, with Responses will result in **better model intelligence when compared to Chat Completions**. Our internal evals reveal a **3% improvement in SWE-bench** with same prompt and setup.*

> **OpenAI 原文**（[Cookbook: Better performance from reasoning models using the Responses API](https://developers.openai.com/cookbook/examples/responses_api/reasoning_items)）：
>
> *While this toy example may not clearly show the benefits—since the model will likely perform well with or without the reasoning item—our own tests found otherwise. **On a more rigorous benchmark like SWE-bench, including reasoning items led to about a 3% improvement for the same prompt and setup.***
>
> *In our tests, **switching from the Completions API to the Responses API boosted cache utilization from 40% to 80%**. Higher cache utilization leads to lower costs (for example, cached input tokens for `o4-mini` are 75% cheaper than uncached ones) and improved latency.*
>
> *Crucially, to maximize the model's intelligence, we should include the reasoning item by simply adding all of the output back into the context for the next turn. [...] **Note that while this is another API call, we consider this as a single turn in the conversation.***

### Gemini 的 thinking

```jsonc
// 请求
{
  "thinking_config": {
    "thinking_budget": 2048           // token 预算
    // 或 include_thoughts: true       // 老版本
  }
}

// 响应 —— thoughtSignature 是 part 级字段，挂在对应 part 上（不是响应顶层）
{
  "candidates": [{
    "content": {
      "parts": [
        { "thought": "需要查北京天气...", "thoughtSignature": "sig_xyz..." },  // 推理 + 签名
        { "functionCall": { "name": "get_weather", ... } }
      ]
    },
    "finishReason": "STOP"
  }]
}
```

处理方式类似 Anthropic——thought 和 functionCall 可以在 parts 中混合，需要原样保留签名。但实际实现不如 Anthropic 成熟，交织模式的支持取决于具体模型版本。

### 对 Agent 框架的影响

```
无 thinking:
  API call → tool_calls → execute → API call → tool_calls → execute → final text
  每一步是盲目的——模型只能在收到上一步结果后才能"想到"下一步该做什么

有 thinking:
  API call → [think] → tool_call_1 → [think] → tool_call_2 → [think] → final text
  模型可以在调用前规划、调用后反思、在工具之间做中间推理
```

对于 Agent 框架来说，这意味着：

1. **content/parts 的表示必须是类型化数组**——不能再假设"一个 message 只有一段文本"。Anthropic 的 content block 模型天然适配；OpenAI Chat 的 message 模型需要扩展字段
2. **上下文管理要考虑 thinking tokens**——thinking 内容通常比最终回复长的多（几百到几千 tokens），但不参与最终输出，需要独立处理截断策略
3. **签名的保留是硬性要求**——Anthropic 和 Gemini 的签名机制意味着 agent 框架不能随意修改或裁剪 messages，否则模型行为会降级

