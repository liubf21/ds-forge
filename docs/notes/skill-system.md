# Skill 系统设计笔记

> 状态：已实现（`src/skills.ts` + Forge/AgentSession/TUI 集成 + 16 个单测）
> 对应 TODO：二.🧩 扩展机制 — Skill 系统（简化版）

## 一、核心决策：为什么是「渐进式披露 + tool」

文档里其实有两套 Skill 模型：

| 模型 | 来源 | 触发方式 |
|------|------|----------|
| 斜杠命令 | `tool-design.md §6` | `forge.run("/review foo.ts")`，`${arguments}` 注入 |
| 渐进式披露 | `EXTENSION_SYSTEMS.md §3` / 现代 Claude/Cursor | 模型看 catalog，按需 load |

**选了渐进式披露**，理由（first principles）：

1. **复用现有抽象**：Skill 的本质是「按需注入 context 的文本」，`Tool` 已经是「按需产生 context 文本」的机制。注册一个 `skill` 工具即可，零新机制、零 agent loop 改动。
2. **契合 V4 经济学**：system prompt 只放 catalog（每个 skill 一行 name+description），正文按需加载。100 个 skill ≈ 100 行 prompt，正文不预先占 context。长上下文 + 低成本下这是最自然的形态。
3. **不耦合 UI**：斜杠命令在 TODO 里被否决（与 UI 耦合）。tool 调用是模型自主的，库层面干净。
4. **心智模型对齐**：和真实 skill 系统（本仓库自己用的 SKILL.md）一致 —— 广告 name+description，相关时才读全文。

同时保留 `renderSkill()` 给程序化/headless 调用（斜杠模型的能力没丢，只是不进 agent loop）。

## 二、模块结构（`src/skills.ts`，约 350 行）

```
parseFrontmatter(text)        → 极简 YAML 子集解析（scalar / 行内数组 / 块数组 / 去引号）
parseSkill(md, {path,dir})    → SkillDef（name 缺省取目录名）
loadSkillsFromDir(dir)        → 扫 <dir>/<name>/SKILL.md + 兼容 <dir>/<name>.md
discoverSkills({cwd,dirs,...})→ 分层发现 + 去重（extra dirs > 最近项目 .agents/skills > ~/.agents/skills）
SkillRegistry                 → register/get/has/list/size，镜像 ToolRegistry 风格
renderSkill(skill, args)      → 插值 ${arguments}/${args}/${SKILL_DIR}/${named}
skillsCatalog(registry)       → system prompt 段落
skillTool(registry)           → 渐进式披露工具（未知 name 返回可用列表，便于模型自纠）
toSkillRegistry(src, cwd)     → SkillRegistry | string[] 归一
```

不写自己的 YAML 库依赖：只支持 SKILL.md 实际用到的子集，保持零依赖、可控。

## 三、Forge 集成（最小侵入）

- `ForgeConfig.skills?: SkillRegistry | string[]`
- 构造函数：`toSkillRegistry` → 若 `size>0` 则存 `this.skills` 并 `tools.register(skillTool(...))`
- **顺序关键**：在 `resolveReasoningEffort` 之前注册，使「有 skill ⇒ 有 tool ⇒ effort=high」成立
- system 注入：`[config.system, skillsCatalog(...)].filter(Boolean).join("\n\n")`
- `Forge.load` 透传 `skills`：resume 时重新注册 `skill` 工具（catalog 已烘焙进存档的 system，无需重注）

`types.ts` 用 `import type { SkillRegistry }` 避免运行时循环依赖（types→skills→tools→types 仅类型，擦除后无环）。

## 四、Codex 对齐：路径从 `.claude` 切到 `.agents`

复核 Codex 官方文档后，把主发现路径从 Claude Code 风格的 `.claude/skills` 改为更通用的 Codex / open agent skills 风格：

| Scope | Path | 默认 |
|-------|------|------|
| Project | `cwd → git root` 每层 `.agents/skills` | TUI 默认开 |
| User | `~/.agents/skills` | TUI 显式 `--user-skills` |
| Extra dirs | 调用方传入 `dirs` / `skills` | 显式 |

`AgentSession` 只新增 `skills?: SkillRegistry | string[]` 透传，不自己默认扫目录；TUI 是产品入口，所以默认调用 `discoverSkills({ cwd, includeUser: false })`。这样保持边界干净：library/preset 不暗读用户全局目录，TUI 提供开箱即用的项目 skill。

由于当前 `SkillRegistry` 以 name 为 key，无法像 Codex selector 一样同时展示两个同名 skill。折中规则是 **nearest wins**：项目目录按 `cwd → git root` 顺序扫描，离当前工作目录更近的同名 skill 优先。

## 五、刻意没做的（v1 边界）

- **allowed-tools 硬隔离**：只作为 advisory 文本透传给模型。真正的中途工具门控要改 agent loop，复杂度不值，留 v2。
- **fork / 子进程执行**：V4 thinking 模式下模型能自己规划步骤（见 tool-design.md 实验清单假设）。先不做，等验证。
- **paths 文件匹配自动显示 / hooks 关联**：等 Hook 系统落地再联动。
- **MCP / plugin skills**：等多服务器管理成型后再接。

## 六、验证

`examples/skills_test.ts`，16 个用例覆盖：frontmatter 三种形态、name 缺省、缺失目录、目录+单文件、项目链发现、最近目录同名优先、extra dir 冲突优先级、插值、catalog、skillTool（命中/未命中）、Forge 注册 + 注入、AgentSession 透传、空 registry 不注册。已接入 `npm test`。
