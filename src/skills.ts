/**
 * Skill system — reusable prompt packs loaded from `.agents/skills/`.
 *
 * Model: progressive disclosure. The agent sees a catalog (name + description)
 * in its system prompt and loads a skill's full instructions on demand via the
 * `skill` tool. This reuses the existing tool mechanism — no UI coupling, no
 * slash commands — and scales to many skills without bloating the prompt.
 *
 * A skill is `<dir>/<name>/SKILL.md`: YAML frontmatter + markdown body.
 *
 *   ---
 *   name: code-review
 *   description: Review code changes for security, performance, and style.
 *   allowed-tools: [read, grep, bash]
 *   model: deepseek-v4-pro
 *   ---
 *   Review the files in ${arguments} with focus on ...
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { tool } from "./tools.js";
import type { Tool } from "./types.js";

export interface SkillDef {
  /** Unique identifier the model passes to the `skill` tool. */
  name: string;
  /** One-line summary shown in the catalog — the model uses it to decide relevance. */
  description: string;
  /** Advisory tool whitelist for this skill (surfaced to the model, not enforced). */
  allowedTools?: string[];
  /** Advisory model override. */
  model?: string;
  /** Markdown instructions (frontmatter stripped). */
  body: string;
  /** Directory holding SKILL.md — used to resolve `${SKILL_DIR}` and scripts. */
  dir: string;
  /** Absolute path to the source file. */
  path: string;
}

export const SKILLS_DIR = ".agents/skills";
export const USER_SKILLS_DIR = ".agents/skills";

// ── frontmatter ────────────────────────────────────────────

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function stripQuotes(s: string): string {
  const t = s.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

function parseInlineArray(s: string): string[] {
  return s
    .slice(1, -1)
    .split(",")
    .map((x) => stripQuotes(x))
    .filter((x) => x.length > 0);
}

/**
 * Parse a minimal YAML subset: `key: scalar`, inline arrays `key: [a, b]`, and
 * block arrays (`key:` then `  - item` lines). Sufficient for SKILL.md headers.
 */
export function parseFrontmatter(text: string): {
  data: Record<string, string | string[]>;
  body: string;
} {
  const m = FRONTMATTER_RE.exec(text);
  if (!m) return { data: {}, body: text };

  const data: Record<string, string | string[]> = {};
  const lines = m[1]!.split(/\r?\n/);
  let listKey: string | null = null;

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && listKey) {
      (data[listKey] as string[]).push(stripQuotes(item[1]!));
      continue;
    }

    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!;
    const rest = kv[2]!.trim();

    if (rest === "") {
      data[key] = [];
      listKey = key;
    } else if (rest.startsWith("[") && rest.endsWith("]")) {
      data[key] = parseInlineArray(rest);
      listKey = null;
    } else {
      data[key] = stripQuotes(rest);
      listKey = null;
    }
  }

  return { data, body: (m[2] ?? "").trim() };
}

function asArray(v: string | string[] | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

function asString(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v.join(", ") : v;
}

/** Build a SkillDef from raw markdown. Name defaults to the directory name. */
export function parseSkill(
  markdown: string,
  opts: { path: string; dir: string; fallbackName?: string },
): SkillDef {
  const { data, body } = parseFrontmatter(markdown);
  const name = asString(data.name) ?? opts.fallbackName ?? basename(opts.dir);
  return {
    name,
    description: asString(data.description) ?? "",
    allowedTools: asArray(data["allowed-tools"] ?? data.tools),
    model: asString(data.model),
    body,
    dir: opts.dir,
    path: opts.path,
  };
}

// ── loading ────────────────────────────────────────────────

/**
 * Load skills from a directory. Supports the directory form
 * (`<dir>/<name>/SKILL.md`) and the legacy single-file form (`<dir>/<name>.md`).
 * Missing directories yield an empty list.
 */
export function loadSkillsFromDir(dir: string): SkillDef[] {
  const root = resolve(dir);
  if (!existsSync(root)) return [];

  const out: SkillDef[] = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      const skillFile = join(full, "SKILL.md");
      if (existsSync(skillFile)) {
        out.push(
          parseSkill(readFileSync(skillFile, "utf-8"), {
            path: skillFile,
            dir: full,
            fallbackName: entry,
          }),
        );
      }
    } else if (entry.endsWith(".md")) {
      out.push(
        parseSkill(readFileSync(full, "utf-8"), {
          path: full,
          dir: root,
          fallbackName: entry.replace(/\.md$/, ""),
        }),
      );
    }
  }
  return out;
}

export interface DiscoverOptions {
  /** Project directory; scans `.agents/skills` from cwd up to git root. */
  cwd?: string;
  /** Also scan `~/.agents/skills`. Default: true. */
  includeUser?: boolean;
  /** Also scan project `.agents/skills` directories. Default: true. */
  includeProject?: boolean;
  /** Extra directories to scan (highest precedence, in order). */
  dirs?: string[];
}

/** Ancestor dirs from `start` up to the filesystem root (inclusive), nearest first. */
function ancestors(start: string): string[] {
  const out: string[] = [];
  let dir = resolve(start);
  for (;;) {
    out.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

/**
 * Project skill directories from cwd up to git root, nearest first. Nearest
 * wins on duplicate skill names because this registry addresses skills by name.
 */
export function projectSkillDirs(cwd: string = process.cwd()): string[] {
  const chain = ancestors(cwd);
  const gitRootIdx = chain.findIndex((d) => existsSync(join(d, ".git")));
  const boundaryIdx = gitRootIdx === -1 ? 0 : gitRootIdx;
  return chain.slice(0, boundaryIdx + 1).map((d) => join(d, SKILLS_DIR));
}

/**
 * Discover skills across the standard layers. Precedence (first wins on name
 * collision): extra `dirs` > nearest project `.agents/skills` > user `~/.agents/skills`.
 */
export function discoverSkills(opts: DiscoverOptions = {}): SkillRegistry {
  const cwd = opts.cwd ?? process.cwd();
  const layers: string[] = [...(opts.dirs ?? [])];
  if (opts.includeProject !== false) {
    layers.push(...projectSkillDirs(cwd));
  }
  if (opts.includeUser !== false) {
    layers.push(join(homedir(), USER_SKILLS_DIR));
  }

  const reg = new SkillRegistry();
  for (const dir of layers) {
    for (const skill of loadSkillsFromDir(dir)) {
      if (!reg.has(skill.name)) reg.register(skill);
    }
  }
  return reg;
}

// ── registry ───────────────────────────────────────────────

export class SkillRegistry {
  private skills = new Map<string, SkillDef>();

  register(skill: SkillDef): void {
    this.skills.set(skill.name, skill);
  }

  get(name: string): SkillDef | undefined {
    return this.skills.get(name);
  }

  has(name: string): boolean {
    return this.skills.has(name);
  }

  list(): SkillDef[] {
    return [...this.skills.values()];
  }

  get size(): number {
    return this.skills.size;
  }

  [Symbol.iterator](): IterableIterator<SkillDef> {
    return this.skills.values();
  }
}

/** Coerce a registry or directory list into a SkillRegistry. */
export function toSkillRegistry(
  source: SkillRegistry | string[],
  cwd?: string,
): SkillRegistry {
  if (source instanceof SkillRegistry) return source;
  return discoverSkills({ cwd, dirs: source });
}

// ── rendering ──────────────────────────────────────────────

/**
 * Interpolate a skill body. Substitutes `${arguments}`/`${args}` with the raw
 * argument string, `${SKILL_DIR}` with the skill directory, and `${name}` with
 * matching keys from `named`.
 */
export function renderSkill(
  skill: SkillDef,
  args?: string | Record<string, string>,
): string {
  const named = typeof args === "object" && args !== null ? args : {};
  const argString =
    typeof args === "string"
      ? args
      : Object.values(named).join(" ");

  return skill.body.replace(/\$\{(\w+)\}/g, (whole, key: string) => {
    if (key === "arguments" || key === "args") return argString;
    if (key === "SKILL_DIR") return skill.dir;
    if (key in named) return named[key]!;
    return whole;
  });
}

/** System-prompt section listing available skills (one line each). */
export function skillsCatalog(registry: SkillRegistry): string {
  if (registry.size === 0) return "";
  const lines = registry
    .list()
    .map((s) => `- ${s.name}: ${s.description}`)
    .join("\n");
  return `## Available skills

Reusable instruction packs. When a task matches one, call the \`skill\` tool with its name to load full instructions before proceeding.

${lines}`;
}

// ── tool (progressive disclosure) ──────────────────────────

/**
 * Build the `skill` tool. The model calls it with a skill `name` to load that
 * skill's instructions into context, optionally passing `arguments` for
 * interpolation. Unknown names return the available list so the model can retry.
 */
export function skillTool(registry: SkillRegistry): Tool {
  return tool({
    name: "skill",
    description:
      "Load a reusable skill (instruction pack) by name. Returns its full " +
      "instructions, which you must then follow. Call this when a task matches " +
      "one of the available skills listed in the system prompt.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Skill name to load (must match an available skill).",
        },
        arguments: {
          type: "string",
          description:
            "Optional arguments interpolated into the skill body (${arguments}).",
        },
      },
      required: ["name"],
    },
    execute: (args) => {
      const name = String(args.name ?? "");
      const skill = registry.get(name);
      if (!skill) {
        const names = registry.list().map((s) => s.name);
        return `Error: unknown skill '${name}'. Available: ${
          names.length ? names.join(", ") : "(none)"
        }`;
      }

      const rawArgs = args.arguments;
      const body = renderSkill(
        skill,
        typeof rawArgs === "string" ? rawArgs : undefined,
      );

      const header: string[] = [`# Skill: ${skill.name}`];
      if (skill.allowedTools?.length) {
        header.push(`Intended tools: ${skill.allowedTools.join(", ")}`);
      }
      if (skill.model) header.push(`Suggested model: ${skill.model}`);

      return `${header.join("\n")}\n\n${body}`;
    },
  });
}
