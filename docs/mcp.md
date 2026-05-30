# MCP 协议原理

[文档索引](README.zh-CN.md)

一份给初学者的说明，从 tool calling 讲起，再引出 MCP。

## 目录

0. [前置：LLM Tool Calling](#0-前置llm-tool-calling)
1. [为什么需要 MCP](#1-为什么需要-mcp)
2. [协议分层](#2-协议分层)
3. [三种传输方式](#3-三种传输方式)
4. [旧 HTTP+SSE vs Streamable HTTP](#4-旧-httpssse-vs-streamable-http)
5. [完整数据流](#5-完整数据流)
6. [本项目实现结构](#6-本项目实现结构)

---

## 0. 前置：LLM Tool Calling

### 模型不是全能的

LLM 是一个**文本补全引擎**——输入文本，输出文本。它没有内置计算器、不会调用 API、不知道实时数据。

```text
User: 现在旧金山的气温是多少摄氏度？
Model: 我无法获取实时数据，建议您查看天气网站...
```

Tool calling 就是让模型**输出 JSON 而非自然语言**，告诉外部系统："帮我查一下这个"。

### 核心流程：Agent Loop

```
User: "3 加 4 等于多少"
  │
  ▼
┌─ 第 1 次 API 调用 ──────────────────────────┐
│  POST /chat/completions                      │
│  { model,                                  │
│    messages: [{role:"user", content:"3+4?"}],│
│    tools: [{ name:"add",                     │   ← 声明了哪些工具可用
│      description:"两个整数相加",             │
│      parameters: { a: int, b: int } }]       │
│  }                                           │
│                                              │
│  → Response:                                 │
│  { choices: [{                               │
│    finish_reason: "tool_calls",              │   ← 不是文本，而是工具调用
│    message: {                                │
│      tool_calls: [{                          │   ← 一个调用列表
│        function: { name: "add",              │
│          arguments: '{"a":3,"b":4}' }        │
│      }]                                      │
│    }                                         │
│  }] }                                        │
└──────────────────────────────────────────────┘
  │
  ▼  ← Agent 收到 tool_calls，执行工具
┌─ 工具执行 ──────────────────────────────────┐
│  result = add(3, 4)  →  7                   │
│                                              │
│  将结果作为新 message 追加到对话:            │
│  messages.push({                             │
│    role: "tool",                             │   ← 角色是 "tool"
│    tool_call_id: "...",                      │
│    content: "7"                              │
│  })                                          │
└──────────────────────────────────────────────┘
  │
  ▼  ← 带着 tool result 再次调用 API
┌─ 第 2 次 API 调用 ──────────────────────────┐
│  messages: [                                 │
│    user: "3+4?",                             │
│    assistant: { tool_calls: [add(3,4)] },    │
│    tool: { result: "7" }                     │
│  ]                                           │
│                                              │
│  → Response:                                 │
│  { choices: [{                               │
│    finish_reason: "stop",                    │   ← 不再调用工具
│    message: { content: "3 加 4 等于 7。" }  │   ← 最终文本回复
│  }] }                                        │
└──────────────────────────────────────────────┘
```

（上图的 `tools` / `parameters` 字段为简化示意，精确的 wire format 见下一节。）

Agent loop 的本质是**一个 while 循环**：

```python
while True:
    response = api.chat(messages, tools)
    messages.append(response.message)          # 先存模型这轮回复（含 tool_calls）
    if response.finish_reason == "stop":
        return response.content                # 完成
    for call in response.tool_calls:           # finish_reason == "tool_calls"
        result = execute(call)                 # 执行工具
        messages.append({
            "role": "tool",
            "tool_call_id": call.id,           # 必须带 id，与 tool_calls 匹配
            "content": result,
        })
```

### OpenAI Tool Call 格式（事实标准）

这套格式最早由 OpenAI **Chat Completions** 引入，后来被几乎所有第三方 API（DeepSeek、Qwen、Groq 等）照搬，成了生态里跨厂商互操作的**事实标准**。

但"事实标准"要打两个折扣：

1. **连 OpenAI 自己都在迁移**：官方现在主推更新的 [Responses API](./llm-protocols.md#3-openai-responses)，Chat Completions 这套更像是"被第三方生态固化下来的旧标准"，而非 OpenAI 的当前首选。
2. **Claude / Gemini 根本不用它**：Claude 走 `tool_use` / `tool_result`，Gemini 走 `functionDeclarations` / `functionCall`（且无 tool call ID），各有自己的协议。

完整的字段级 wire format 和四家 API 的逐项对比，见 [LLM API 协议对比](./llm-protocols.md)——本节不再重复贴格式，只提炼三个关键点：

1. **工具声明是 JSON Schema**：模型不"看代码"，只看 name + description + 参数定义，自行判断何时调用
2. **arguments 是 JSON 字符串**：代理层负责 `JSON.parse()` 解析
3. **结果 content 是纯文本**：工具返回什么文本，模型就看到什么文本——没有类型系统

### Tool Calling 解决了什么，没解决什么

| 已解决 | 未解决 |
|---|---|
| 模型表达"我想调用什么、传什么参数" | 工具实现在哪里？（本地？远程？哪个 URL？） |
| LLM API → Agent 的格式统一 | Agent → 工具执行层 完全没有标准 |
| finish_reason 判断是否继续调用 | 工具怎么发现？（硬编码列表？扫描注册表？） |

**Tool calling 定义了"对话协议"——LLM 和 Agent 之间怎么说。MCP 定义了"工具协议"——Agent 和工具执行器之间怎么说。两者拼起来才是完整的 Agent 链路。**

---

## 1. 为什么需要 MCP

LLM 的 tool calling 解决了"模型如何表达调用意图"，但没有解决"工具实现在哪里、如何发现"。

**没有 MCP 时**，每家服务用不同的 HTTP 方式暴露工具：

| 服务 | 发现入口 | 调用格式 |
|---|---|---|
| A 服务 | `GET /api/tools` | 自定义 JSON |
| B 服务 | `GET /v2/schemas` | OpenAPI spec |
| C 服务 | 无发现机制 | 靠文档手动配置 |

Agent 代码要为每个服务写适配层。

**MCP 做的事**——在 HTTP 之上补两层：**服务发现**和**能力协商**，统一为三个标准操作：

```
initialize   → 握手，协商协议版本和能力
tools/list   → 发现服务器提供的所有工具
tools/call   → 执行一个工具
```

任何 MCP client 和任何 MCP server 不需要适配代码。MCP 对于 LLM 工具层 ≈ HTTP 对于万维网文档层——一个标准化协议在分散生态里创造互操作性。

```
之前:  Agent ─── 直接引用 ─── Tool (硬编码)
之后:  Agent ─── MCPClient ─── Transport ─── MCP Server (独立进程/服务)
```

---

## 2. 协议分层

三层，每层独立：

```
┌──────────────────────────────────┐
│        MCP Protocol              │  ← 语义层: initialize, tools/list, tools/call
├──────────────────────────────────┤
│        JSON-RPC 2.0              │  ← 消息信封: {jsonrpc, id, method, params, result}
├──────────────────────────────────┤
│        Transport                 │  ← 传输层: stdio 或 Streamable HTTP
└──────────────────────────────────┘
```

### JSON-RPC 2.0（消息信封）

每条消息带 `id`，响应通过 `id` 匹配。三种消息类型：

```jsonc
// 请求 (Request) — 有 id + method
{"jsonrpc":"2.0", "id":1, "method":"tools/list", "params":{}}

// 响应 (Response) — 有 id + result 或 error
{"jsonrpc":"2.0", "id":1, "result":{"tools":[...]}}
{"jsonrpc":"2.0", "id":1, "error":{"code":-32601, "message":"Method not found"}}

// 通知 (Notification) — 有 method，无 id，不期待响应
{"jsonrpc":"2.0", "method":"notifications/initialized", "params":{}}
```

### MCP 协议方法

| Method | 方向 | 类型 | 作用 |
|---|---|---|---|
| `initialize` | C→S | 请求 | 握手，协商协议版本和能力 |
| `tools/list` | C→S | 请求 | 发现工具列表 |
| `tools/call` | C→S | 请求 | 执行一个工具 |
| `notifications/initialized` | C→S | 通知 | 客户端确认初始化完成 |
| `notifications/tools/list_changed` | S→C | 通知 | 服务端通知工具列表已变更 |

---

## 3. 三种传输方式

| | stdio | HTTP+SSE (旧) | Streamable HTTP (现行) |
|---|---|---|---|
| 状态 | 现行 | 已废弃 | 现行 |
| 连接数 | 0 (无网络) | 2 条 TCP | 1 条 TCP |
| 进程生命周期 | 客户端 spawn/kill | 服务端独立运行 | 服务端独立运行 |
| 适合场景 | 本地工具 | 已被替代 | 远程服务、多客户端、serverless |
| serverless 兼容 | N/A | 否 | 是 |

### stdio

```
Agent ── spawn ──→ MCP Server (子进程)
  │                    │
  ├── JSON + \n ──────→ stdin
  │←── JSON + \n ───── stdout
  │
  └── kill ──────────→ 进程退出
```

- 客户端用 `spawn()` 启动服务端进程
- 每条消息是一行 JSON，以 `\n` 分隔
- 生命周期绑定：客户端退出 → 服务端退出

stdio 本身只约束通信方式，不管代码来源。三种常见场景：

| 场景 | 命令示例 | 代码在哪 |
|---|---|---|
| 本地开发 | `node ./my-server.js` | 项目目录，自己写的 |
| 系统安装 | `python -m mcp_server_git` | pip/brew 全局安装的包 |
| 按需拉取 | `npx -y @modelcontextprotocol/server-filesystem` | npm registry 下载到临时缓存 |

stdio 也不意味着代码逻辑必须在本地执行——可以是一个 thin client：

```
Agent ── stdio ── 本地 thin client ── HTTP ── 远程 SaaS
```

MCP 协议在这个场景下充当**本地适配层**：agent 只认 MCP 接口，thin client 负责协议转换和认证（token 存本地，不给 agent）。

### 安全上的区别

- **stdio**：代码在本地进程跑，权限 = 当前用户权限。可以审计源码，但恶意 server 能做到的事和你的 shell 一样多
- **HTTP**：工具代码在服务端跑，客户端只有调用结果。信任边界在远程服务

---

## 4. 旧 HTTP+SSE vs Streamable HTTP

### 旧版：两条连接

```
  GET /sse  ──── SSE 长连接 ──────┐
    ↳ 收 endpoint URL             │  这条连接一直开着
    ↳ 收 server push 通知          │  用来收服务端主动推送
    ↳ 断了 = 会话丢失              │
  POST /message ── JSON-RPC ─────┘
    ↳ 发请求，收响应              这条是短连接
    ↳ 一次请求一次响应
```

### Streamable HTTP：一条连接

```
  POST /mcp ────→
    Mcp-Session-Id: sess_abc123
    ← 普通请求 → JSON (Content-Type: application/json)
    ← 长任务   → SSE  (Content-Type: text/event-stream)
```

**演进本质**：把"会话"从传输层（TCP 长连接）提升到应用层（HTTP header `Mcp-Session-Id`）。

**为什么废弃旧的**：

- **Serverless 不兼容**：Cloud Run、Lambda 不支持 SSE 长连接，超时就断
- **负载均衡复杂**：SSE 长连接和 POST 短连接混在一起，路由策略难以统一
- **重连没有标准**：SSE 断了怎么恢复？期间丢失的通知怎么补？协议没规定
- **防火墙误杀**：很多企业网络把 SSE 长连接当异常流量

新的 Streamable HTTP 就是一次普通 POST，serverless 友好，任何 HTTP 代理都能处理。

### Wire format 对比

运行 `npx tsx examples/mcp_transport_comparison.ts` 查看完整例子。关键区别：

```
# 旧：initialize 需要两步
GET /sse                          ← 先建 SSE 长连接
POST /message {initialize...}     ← 再发 JSON-RPC

# 新：一步完成
POST /mcp {initialize...}         ← 直接发，响应带回 session ID
  → 200, Mcp-Session-Id: sess_abc123

# 旧：server push 依赖 SSE 长连接
(event 从 GET /sse 连接推过来)
event: tools/list_changed

# 新：server push 不再必要
# 客户端需要时主动 re-query tools/list
```

---

## 5. 完整数据流

以 `Forge.run("add 3 and 4")` 为例，展示从 agent 到 MCP server 再返回的完整链路：

```
Forge.run("add 3 and 4")
  │
  ▼
┌─ Forge._send() ────────────────────────────────────┐
│  1. context.truncate()                              │
│  2. client.chat.completions.create(messages, tools) │  ← DeepSeek API
│  3. response → tool_calls: [{name:"add", args:...}] │
└─────────────────────────────────────────────────────┘
  │
  ▼
┌─ Forge agent loop ─────────────────────────────────┐
│  for tc in tool_calls:                              │
│    args = JSON.parse(tc.function.arguments)         │
│    result = await tool.execute(args)   ◄── 闭包调用  │
│             │                                       │
│             ▼                                       │
│  ┌─ MCP Tool (闭包) ────────────────────────────┐  │
│  │  await mcp._request("tools/call", {          │  │
│  │    name: "add",                              │  │
│  │    arguments: { a: 3, b: 4 }                 │  │
│  │  })                                          │  │
│  └──────────────────┬───────────────────────────┘  │
│                     │                              │
│                     ▼                              │
│  ┌─ MCPClient._request() ──────────────────────┐  │
│  │  id = nextId++                               │  │
│  │  pending.set(id, { resolve, reject, timer }) │  │
│  │  transport.send({ jsonrpc, id, method,       │  │
│  │                   params })                  │  │
│  │  return new Promise(...)  ← 等匹配 id 的响应  │  │
│  └──────────────────┬───────────────────────────┘  │
│                     │                              │
│                     ▼                              │
│  ┌─ StdioTransport ────────────────────────────┐  │
│  │  proc.stdin.write(JSON + '\n')               │  │
│  │  proc.stdout.on('data'):                     │  │
│  │    → 按 \n 拆行                              │  │
│  │    → JSON.parse(line)                        │  │
│  │    → cbs.onMessage(msg)                     │  │
│  └──────────────────┬───────────────────────────┘  │
│                     │                              │
│                     ▼                              │
│  ┌─ MCP Server (独立进程) ──────────────────────┐  │
│  │  readline('line'):                           │  │
│  │    msg = JSON.parse(line)                    │  │
│  │    result = Number(args.a) + Number(args.b)  │  │
│  │    stdout.write(JSON.stringify({             │  │
│  │      jsonrpc: "2.0",                         │  │
│  │      id: msg.id,                             │  │
│  │      result: { content: [                    │  │
│  │        { type: "text", text: "7" }           │  │
│  │      ] }                                     │  │
│  │    }) + '\n')                                │  │
│  └──────────────────┬───────────────────────────┘  │
│                     │                              │
│                     ▼                              │
│  ┌─ 响应匹配 ──────────────────────────────────┐  │
│  │  _handleMessage(resp)                        │  │
│  │    pending = this.pending.get(resp.id)       │  │
│  │    clearTimeout(pending.timer)               │  │
│  │    pending.resolve(resp.result)              │  │
│  │  → { content: [{ type: "text", text: "7" }] }│  │
│  └─────────────────────────────────────────────┘  │
│                                                    │
│  result = "7"  ← content 数组转字符串               │
│  context.addToolResult(call_id, "7", "add")        │
└────────────────────────────────────────────────────┘
  │
  ▼
→ 下一轮 API 调用: model 收到 tool result，决定不再调用工具
→ forge.run() 返回最终文本
```

关键设计点：

- **request/response 匹配在 MCPClient 层做**，不在 Transport 层。因为 HTTP 的 send 本身就是同步等响应，而 stdio 的 send 是异步收响应。把匹配逻辑统一放在上层，Transport 就变成纯管道
- **Tool 的 execute 是闭包**，捕获 MCPClient 的 transport。每次调用时发 `tools/call` 到服务端，工具状态由服务端管理
- **错误是字符串而非异常**：`"Error: ..."` 返回给模型，模型看到可以重试。不抛异常意味着 agent loop 不中断

---

## 6. 本项目实现结构

```
src/mcp/
  types.ts              ← JSON-RPC 类型 + Transport 接口 + MCP 协议类型
  transport-stdio.ts    ← StdioTransport: spawn 子进程, newline-delimited JSON
  transport-http.ts     ← HTTPTransport: POST + JSON/SSE 解析 + session ID
  client.ts             ← MCPClient: initialize → tools/list → tools/call
  index.ts              ← barrel export

examples/
  mcp_echo_server.ts             ← 最小 MCP server（教学用，展示 wire format）
  mcp_python_server.ts           ← 执行 Python 代码的 MCP server（run_python，子进程 + 超时）
  mcp_demo.ts                    ← Forge agent loop + MCP tools（需要 API key）
  mcp_test.ts                    ← 9 个测试（无需 API key）
  mcp_transport_comparison.ts    ← 旧 HTTP+SSE vs Streamable HTTP 对比
```

### Transport 接口（4 个方法）

```typescript
interface MCPTransport {
  start(): Promise<void>;                        // 打开连接
  send(msg: JSONRPCMessage): Promise<void>;      // 发消息
  close(): Promise<void>;                        // 关闭连接
  setCallbacks(cb: TransportCallbacks): void;    // 注册收消息回调
}
```

Transport 不知道 JSON-RPC 的语义，不知道 request/response 匹配，只是一个双向消息管道。换传输方式只需改一行构造参数。

### 裸 stdio 调试（不写代码直接测 server）

stdio server 收发的就是 newline-delimited JSON，所以不需要 client，用 `printf` 把几行 JSON-RPC 管进 stdin 就能看 wire format：

```bash
printf '%s\n' \
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
'{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
'{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"run_python","arguments":{"code":"print(2**10)"}}}' \
| npx tsx examples/mcp_python_server.ts
```

每行一条消息，server 逐行解析、逐条回 JSON。这是排查 server bug 最快的方式——绕开了 client、agent、模型，直接看协议层。

> 注意：响应可能**乱序返回**。`mcp_python_server.ts` 的 `tools/call` 是异步执行的，慢的调用后回；client 靠 `id` 匹配，与顺序无关。

用 `MCPClient` / agent loop 跑同一个 server，改 `examples/mcp_demo.ts` 顶部的 CONFIG 块即可（选 server、列要测的工具调用，不用的注释掉）。
