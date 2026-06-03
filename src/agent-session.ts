import { mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { bashTool } from "./bash.js";
import { Forge } from "./forge.js";
import { codingAgentSystem } from "./system.js";
import type { BashOptions } from "./bash.js";
import type { ReasoningEffort, Tool } from "./types.js";

export const TRAJECTORY_DIR = resolve(process.env.DS_FORGE_DIR ?? "./trajectories");

export { codingAgentSystem } from "./system.js";

export function createTrajectoryPath(): string {
  mkdirSync(TRAJECTORY_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return join(TRAJECTORY_DIR, `task-${ts}.json`);
}

export function trajectoryLabel(path: string): string {
  return basename(path);
}

export interface OpenAgentSessionOptions {
  cwd?: string;
  resume?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  system?: string;
  tools?: Tool[];
  bash?: BashOptions;
  apiKey?: string;
}

/** System message from context, or default for cwd. */
function resolveSystem(forge: Forge, cwd: string, override?: string): string {
  if (override) return override;
  const msg = forge.context.messages.find((m) => m.role === "system");
  return msg?.content ?? codingAgentSystem(cwd);
}

/** Headless coding-agent session: Forge + trajectory path + save. */
export class AgentSession {
  readonly forge: Forge;
  readonly cwd: string;
  private _trajPath: string;
  private readonly _system: string;

  constructor(forge: Forge, trajPath: string, cwd: string, system: string) {
    this.forge = forge;
    this._trajPath = trajPath;
    this.cwd = cwd;
    this._system = system;
  }

  get system(): string {
    return this._system;
  }

  get trajPath(): string {
    return this._trajPath;
  }

  save(): void {
    this.forge.save(this._trajPath);
  }

  /** Clear context, restore session system prompt, new trajectory file. Returns the new path. */
  clear(): string {
    this.forge.context.clear();
    this.forge.context.addSystem(this._system);
    this.forge.resetTrajectoryState();
    this._trajPath = createTrajectoryPath();
    return this._trajPath;
  }

  static open(opts: OpenAgentSessionOptions = {}): AgentSession {
    const cwd = opts.cwd ?? process.cwd();
    const bash = bashTool({ cwd, ...opts.bash });
    const tools = opts.tools ?? [bash];

    if (opts.resume) {
      const trajPath = resolve(opts.resume);
      const forge = Forge.load(trajPath, {
        tools,
        apiKey: opts.apiKey,
        reasoningEffort: opts.reasoningEffort,
      });
      if (opts.system) {
        forge.context.addSystem(opts.system);
      }
      const system = resolveSystem(forge, cwd, opts.system);
      return new AgentSession(forge, trajPath, cwd, system);
    }

    const system = opts.system ?? codingAgentSystem(cwd);
    const trajPath = createTrajectoryPath();
    const forge = new Forge({
      apiKey: opts.apiKey,
      model: opts.model,
      reasoningEffort: opts.reasoningEffort,
      system,
      tools,
    });
    return new AgentSession(forge, trajPath, cwd, system);
  }
}
