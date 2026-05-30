# DeepSeek V4：原理与调用指南

[文档索引](README.zh-CN.md)

DeepSeek V4 架构原理、API 用法、以及 Agent 场景下的调用语义。

> **发布**：2026-04-24 Preview · MIT 开源权重 · [官方公告](https://api-docs.deepseek.com/news/news260424) · [技术报告 PDF](https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro/blob/main/DeepSeek_V4.pdf)
>
> **口径**：本文优先采用 DeepSeek 官方 API 文档、官方 HuggingFace model card 和技术报告。V4 仍是 Preview，API、价格、benchmark 口径可能变化；成本/效果判断需要以项目实测为准。

---

## 目录

1. [模型家族](#1-模型家族)
2. [架构原理](#2-架构原理)
3. [推理模式](#3-推理模式)
4. [API 调用](#4-api-调用)
5. [Agent 场景的关键语义](#5-agent-场景的关键语义)
6. [迁移与选型](#6-迁移与选型)

---

## 1. 模型家族

| | DeepSeek-V4-Pro | DeepSeek-V4-Flash |
|---|---|---|
| **API model id** | `deepseek-v4-pro` | `deepseek-v4-flash` |
| **总参数** | 1.6T | 284B |
| **激活参数** | 49B / token | 13B / token |
| **上下文** | 1M tokens | 1M tokens |
| **最大输出** | 384K tokens | 384K tokens |
| **定位** | 旗舰：复杂 agent、coding、推理 | 快速、低成本；简单 agent 接近 Pro |
| **API 输入价（cache miss）** | $0.435 / 1M tokens | $0.14 / 1M tokens |
| **API 输入价（cache hit）** | $0.003625 / 1M tokens | $0.0028 / 1M tokens |
| **API 输出价** | $0.87 / 1M tokens | $0.28 / 1M tokens |
| **并发限制** | 500 | 2500 |

价格为官方文档在 2026-05-31 的口径。V4-Pro 当前价格来自 75% 折扣；官方说明折扣结束后会正式调整为原价的 1/4。历史原价为 input $1.74 / output $3.48 per 1M tokens。

V4 不是单一模型，而是 **MoE 两档 + 统一 1M 上下文**。与 V3.x 最大的 API 变化：**thinking / non-thinking 不再拆成两个 model id**，而是通过请求参数切换。

### 旧 ID 迁移

| 旧 ID | 当前路由 | 建议迁移 |
|---|---|---|
| `deepseek-chat` | → V4-Flash non-thinking | `deepseek-v4-flash` + `thinking: disabled` |
| `deepseek-reasoner` | → V4-Flash thinking | `deepseek-v4-pro` 或 `-flash` + `thinking: enabled` |

⚠️ `deepseek-chat` 和 `deepseek-reasoner` 将于 **2026-07-24 15:59 UTC** 下线。

---

## 2. 架构原理

V4 的核心贡献不是 raw benchmark SOTA，而是 **提升 1M 上下文的推理效率**。对 agent 而言，tool result 会不断追加进上下文，后续 token 的推理成本由 attention FLOPs 和 KV cache 主导。V4 的架构目标是降低长上下文下的边际成本。

### 2.1 Hybrid Attention：CSA + HCA

长上下文 agent 的瓶颈：每轮 tool result 追加到 context 后，后续每个 token 都要对全部历史做 attention。两个指标决定能否跑长轨迹：

- **single-token inference FLOPs**（算力）
- **KV cache size**（显存）

V4 把 attention 拆成两种机制，并在模型层间组合使用：

```
CSA: 4x compressed sparse attention
HCA: 128x heavily compressed dense attention
MTP block:     sliding-window only
```

#### Compressed Sparse Attention (CSA)

- KV 沿序列维度 **4× 压缩**（softmax-gated pooling + learned positional bias）
- **Lightning indexer**（FP4, ReLU-scored）为每个 query 选 top-k 压缩块
- 继承 V3.2 的 DeepSeek Sparse Attention 思想，但搜索空间已在 4× 压缩后的序列上
- 保留 sliding-window 分支处理最近未压缩 token

**直觉**：中距离上下文——选择性、精细检索。

#### Heavily Compressed Attention (HCA)

- KV **128× 压缩**，不做 sparse selection
- 每个 query 对全部压缩块做 **dense attention**（压缩后序列足够短，dense 也便宜）
- 同样有 sliding-window 处理 recency

**直觉**：远距离上下文——全局、近似概览。

#### 效果（1M context vs V3.2，官方报告口径）

| 指标 | V4-Pro | V4-Flash |
|---|---|---|
| FLOPs | 27% | ~10% |
| KV cache | 10% | ~7% |
| vs 标准 GQA bf16 | ~2% cache | — |

存储：官方 model card 称 Instruct 版采用 FP4 + FP8 mixed precision，其中 MoE expert 权重用 FP4，多数其它参数用 FP8。更细的 KV / RoPE / indexer 精度属于实现细节，使用时应以技术报告和推理框架实现为准。

### 2.2 Manifold-Constrained Hyper-Connections (mHC)

标准 residual connection 在极深网络中可能出现信号传播不稳定。官方 model card 称 V4 引入 **Manifold-Constrained Hyper-Connections (mHC)** 来增强 residual connection、提升深层网络稳定性，同时保留表达能力。

**对调用方无直接影响**，但解释了 V4 能在 61 层深度上稳定训练/推理。

### 2.3 Muon Optimizer

官方 model card 称 V4 使用 **Muon Optimizer**，目标是更快收敛和更稳定训练。具体哪些参数继续使用 AdamW 属于训练实现细节，应以技术报告为准。

### 2.4 Post-training：Agent 专项

- **32T+** pre-training tokens
- Stage 1：SFT + RL（GRPO）做 expert specialization
- Stage 2：on-policy distillation 统一能力
- agent-oriented post-training，用于强化 coding、tool use、long-horizon reasoning 等场景

---

## 3. 推理模式

V4 统一三个 reasoning effort 档位，通过 API 参数控制，**不切换 model id**：

| 模式 | 特征 | 典型场景 | API |
|---|---|---|---|
| **Non-think** | 快速、无 CoT | 日常对话、低风险任务 | `thinking: { type: "disabled" }` |
| **Think High** | 显式推理链 | 复杂问题、规划 | `thinking: { type: "enabled" }` + `reasoning_effort: "high"` |
| **Think Max** | 极限推理 | SWE-bench 级任务 | `reasoning_effort: "max"` + 建议 context ≥ 384K |

默认：**thinking 默认 enabled**；thinking 模式下默认 effort 为 `high`。复杂 agent 请求（Claude Code 等）会自动升到 `max`。

不传任何参数时等价于 `thinking: enabled` + `reasoning_effort: high`。Thinking 模式会返回 `reasoning_content`，并消耗输出 token。要关闭 thinking，必须显式传 `thinking: { type: "disabled" }`。

### 采样参数

官方推荐（所有模式）：

```
temperature = 1.0
top_p = 1.0
```

Thinking 模式下 `temperature` / `top_p` / `presence_penalty` / `frequency_penalty` **设置了也不报错，但无效果**。

---

## 4. API 调用

### 4.1 基础

```
Base URL:  https://api.deepseek.com
Endpoint:  POST /chat/completions
格式:      OpenAI Chat Completions（也支持 Anthropic Messages API）
```

官方文档中的 OpenAI SDK 示例使用 `base_url="https://api.deepseek.com"`。如果某些 SDK 或网关要求 `/v1`，应作为兼容配置单独验证。

### 4.2 最小示例

**Non-thinking（Flash，低成本）**

```typescript
const response = await client.chat.completions.create({
  model: "deepseek-v4-flash",
  messages: [{ role: "user", content: "Hello" }],
  extra_body: { thinking: { type: "disabled" } },
});
```

**Thinking + Agent**

```typescript
const response = await client.chat.completions.create({
  model: "deepseek-v4-pro",
  messages,
  tools,
  reasoning_effort: "high",           // 或 "max"
  extra_body: { thinking: { type: "enabled" } },
});
```

OpenAI SDK 中 `thinking` 必须放在 `extra_body`；`reasoning_effort` 是顶层参数。

### 4.3 能力边界

| 能力 | V4-Pro | V4-Flash | 说明 |
|---|---|---|---|
| JSON Output | ✅ | ✅ | 官方 API 支持 |
| Tool Calls | ✅ | ✅ | thinking 模式下要正确回传 `reasoning_content` |
| Chat Prefix Completion | ✅ | ✅ | Beta |
| FIM Completion | 仅 non-thinking | 仅 non-thinking | Thinking 模式不可用 |

### 4.4 响应字段

```jsonc
{
  "choices": [{
    "message": {
      "role": "assistant",
      "reasoning_content": "先查日期，再调 weather tool...",  // thinking 模式
      "content": "杭州明天多云 7~13°C",
      "tool_calls": [ ... ]                                      // 若有
    }
  }]
}
```

---

## 5. Agent 场景的关键语义

这是 V4 与 V3 reasoner **行为变化最大**的部分，也是 Agent 框架必须正确处理的地方。

### 5.1 reasoning_content 的生命周期

| 场景 | 是否回传 reasoning_content | 说明 |
|---|---|---|
| **纯对话，无 tool call** | ❌ 不回传 | 新 user 消息后，中间 assistant 的 reasoning 被 API 忽略 |
| **有 tool call 的单轮内** | ✅ 必须回传 | 同一 user turn 内的 sub-turn 之间必须带 reasoning，否则 **400** |
| **有 tool call 的跨 user turn** | ✅ 必须回传 | **V4 新增**：多轮 agent 对话中，跨 user 边界也保留 reasoning |

对比 V3.2：tool 轮次间保留 reasoning，但 **新 user 消息到达时 flush**。V4 在含 tool call 的对话里 **跨 user turn 累积 reasoning**，适合长 horizon agent。

对比 OpenAI Chat Completions（o 系列）：推理不可见、不可回传，复杂 agent 有性能代价。V4 的设计更接近 Anthropic thinking blocks + OpenAI Responses API 的 reasoning item 保留策略。

### 5.2 正确的 Agent Loop 模式

```typescript
// 每个 sub-turn：append 完整 assistant message（含 reasoning_content）
messages.append(response.choices[0].message);

// 等价于：
messages.append({
  role: "assistant",
  content: msg.content,
  reasoning_content: msg.reasoning_content,  // 有 tool call 时必须
  tool_calls: msg.tool_calls,
});

// 执行 tool → append tool result → 下一轮 API call
// 新 user turn 时：若历史含 tool call，仍保留全部 reasoning_content
```

### 5.3 原生 Tool 格式：DSML

HF blog 提到 V4 的 agent/tool 训练涉及 `|DSML|` schema。对通过 DeepSeek OpenAI-compatible API 的调用方而言，仍使用标准 `tools` + `tool_calls` JSON 格式；本地部署原生 checkpoint 或适配推理框架时，才需要关注底层 schema/token 细节。

### 5.4 长上下文使用策略

1M 窗口 **默认可用**，但调用方应区分：

- **容量**（能塞多少 token）
- **检索质量**（长上下文 benchmark 不等于真实 agent 轨迹效果）

实践建议：

- 把 system prompt + 工具 schema 放前面（稳定 prefix，利于 cache）
- Agent 轨迹自然增长时，**优先依赖 V4 的高效 KV** 而非激进截断
- Thinking 会占用输出 token budget；长任务要显式规划 context 和 max output

---

## 6. 迁移与选型

### 6.1 从 V3 ID 迁移

见 [§1 旧 ID 迁移](#旧-id-迁移)。核心变化：thinking 从 model id 变为请求参数，1M context 成为官方服务默认。

### 6.2 选型速查

```
日常对话 / 简单 QA        → v4-flash + thinking disabled
一般 coding agent         → v4-flash + thinking enabled, effort high
复杂 SWE / 长轨迹 agent   → v4-pro + effort max, context ≥ 384K
成本敏感 + 简单 tool 任务  → v4-flash 通常够用（官方称简单 agent 与 Pro 持平）
```

### 6.3 API 默认行为备忘

| 不传时 | 服务端默认 |
|---|---|
| `thinking.type` | `enabled` |
| `reasoning_effort`（thinking 开启时） | `high` |
| `low` / `medium` | 映射为 `high` |
| `xhigh` | 映射为 `max` |

### 6.4 参考链接

- [官方 Preview 公告](https://api-docs.deepseek.com/news/news260424)
- [官方 Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing)
- [Thinking Mode 指南](https://api-docs.deepseek.com/guides/thinking_mode)
- [HuggingFace 权重集合](https://huggingface.co/collections/deepseek-ai/deepseek-v4)
- [HF Blog: Agent 视角解读](https://huggingface.co/blog/deepseekv4)
- [V4-Pro Model Card](https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro)
