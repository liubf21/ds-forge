#!/usr/bin/env npx tsx
/**
 * Multi-step agent with bash tool + trajectory persistence.
 *
 * Usage:
 *   # Run a new task
 *   DEEPSEEK_API_KEY=sk-... npx tsx examples/agent.ts "explain the architecture of this project"
 *
 *   # Resume from a saved trajectory
 *   DEEPSEEK_API_KEY=sk-... npx tsx examples/agent.ts --resume trajectory.json "now check for bugs"
 *
 *   # Replay from a trajectory (read-only, no agent loop)
 *   DEEPSEEK_API_KEY=sk-... npx tsx examples/agent.ts --replay trajectory.json
 *
 *   # Specify working directory
 *   DEEPSEEK_API_KEY=sk-... npx tsx examples/agent.ts --cwd /path/to/project "run the tests"
 *
 * Trajectory files are saved to ./trajectories/ by default.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Forge } from "../src/forge.js";
import { bashTool } from "../src/bash.js";

const TRAJECTORY_DIR = resolve(process.env.DS_FORGE_DIR ?? "./trajectories");

function usage(): never {
  console.log(`
Usage: npx tsx examples/agent.ts [options] <task>

Options:
  --resume <path>     Load and continue from a saved trajectory
  --replay <path>     Stateless replay of a saved trajectory (no agent loop)
  --cwd <dir>         Working directory for bash commands
  --model <name>      Model to use (default: deepseek-chat)
  --max-turns <n>     Max agent turns (default: 20)
  --timeout <ms>      Bash command timeout in ms (default: 30000)

Examples:
  npx tsx examples/agent.ts "what files are in src/?"
  npx tsx examples/agent.ts --cwd /my/project "run the tests and fix failures"
  npx tsx examples/agent.ts --resume trajectories/task.json "continue the work"
  npx tsx examples/agent.ts --replay trajectories/task.json
`);
  process.exit(1);
}

function parseArgs(args: string[]) {
  const opts: {
    resume?: string;
    replay?: string;
    cwd?: string;
    model: string;
    maxTurns: number;
    timeout: number;
    task: string;
  } = {
    model: "deepseek-chat",
    maxTurns: 20,
    timeout: 30_000,
    task: "",
  };

  let i = 0;
  while (i < args.length) {
    switch (args[i]) {
      case "--resume":
        opts.resume = args[++i];
        break;
      case "--replay":
        opts.replay = args[++i];
        break;
      case "--cwd":
        opts.cwd = resolve(args[++i]);
        break;
      case "--model":
        opts.model = args[++i];
        break;
      case "--max-turns":
        opts.maxTurns = parseInt(args[++i], 10);
        break;
      case "--timeout":
        opts.timeout = parseInt(args[++i], 10);
        break;
      case "--help":
      case "-h":
        usage();
      default:
        if (args[i]?.startsWith("-")) usage();
        opts.task = args.slice(i).join(" ");
        i = args.length;
    }
    i++;
  }

  if (!opts.task && !opts.replay) usage();
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // ── Replay mode (stateless) ─────────────────────────────
  if (opts.replay) {
    const msg = await Forge.debug(opts.replay, { model: opts.model });
    console.log("=".repeat(60));
    console.log("REPLAY");
    console.log("=".repeat(60));
    console.log(`Role: ${msg.role}`);
    console.log(`Content:\n${msg.content}`);
    if (msg.tool_calls) {
      console.log("Tool calls:", JSON.stringify(msg.tool_calls, null, 2));
    }
    return;
  }

  // ── Resume mode ─────────────────────────────────────────
  const bash = bashTool({ cwd: opts.cwd, timeout: opts.timeout });

  let forge: Forge;
  let trajPath: string;

  if (opts.resume) {
    console.log(`Loading trajectory: ${opts.resume}`);
    forge = Forge.load(opts.resume, { tools: [bash] });
    trajPath = opts.resume;
  } else {
    // ── New task ──────────────────────────────────────────
    forge = new Forge({
      model: opts.model,
      system: `You are an AI agent with the ability to execute shell commands.

Your working directory is: ${opts.cwd ?? process.cwd()}

Guidelines:
- Use the 'bash' tool to run commands. Think before executing.
- Read files with 'cat', list with 'ls', search with 'grep', etc.
- Be careful with destructive commands (rm, mv, etc.). Confirm before using them.
- When you complete the task, summarize what you did.`,
      tools: [bash],
    });

    // Save path
    mkdirSync(TRAJECTORY_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    trajPath = join(TRAJECTORY_DIR, `task-${ts}.json`);
  }

  // ── Run ─────────────────────────────────────────────────
  console.log("=".repeat(60));
  console.log(opts.resume ? "RESUMING" : "RUNNING");
  console.log("=".repeat(60));
  console.log(`Task: ${opts.task}`);
  console.log(`Trajectory: ${trajPath}`);
  console.log("=".repeat(60));
  console.log();

  const result = await forge.run(opts.task, opts.maxTurns);

  // ── Save trajectory ─────────────────────────────────────
  forge.save(trajPath);
  console.log();
  console.log("=".repeat(60));
  console.log("RESULT");
  console.log("=".repeat(60));
  console.log(result);
  console.log();
  console.log(`Trajectory saved: ${trajPath}`);
  console.log(
    `  ${forge.context.messages.length} messages, model: ${forge.model}`,
  );
  console.log();
  console.log("Next steps:");
  console.log(
    `  Resume:  npx tsx examples/agent.ts --resume ${trajPath} "<next task>"`,
  );
  console.log(
    `  Replay:  npx tsx examples/agent.ts --replay ${trajPath}`,
  );
  console.log(
    `  Inspect: cat ${trajPath} | jq '.messages'`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
