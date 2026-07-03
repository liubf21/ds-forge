#!/usr/bin/env npx tsx
/**
 * Agent TUI — multi-turn chat with streaming (Claude Code style).
 *
 * Usage:
 *   npm run tui
 *   npm run tui -- --cwd /path/to/project
 *   npm run tui -- --resume trajectories/task.json
 *   npm run tui -- --agents          # load project AGENTS.md
 *   npm run tui -- --global-agents   # load global AGENTS.md
 *   npm run tui -- --skills          # load project .agents/skills
 *   npm run tui -- --user-skills     # load ~/.agents/skills
 *   npm run tui -- --template blog   # load templates/blog.md as the system prompt
 */

import React from "react";
import { render } from "ink";
import { resolve } from "node:path";
import { AgentSession, DEFAULT_AGENT_REASONING_EFFORT, DEFAULT_MAX_TURNS, DEFAULT_MODEL, discoverSkills, loadTemplate, type ReasoningEffort } from "../src/index.js";
import App from "./app.js";

function parseArgs(argv: string[]) {
  const opts: {
    cwd: string;
    resume?: string;
    model: string;
    reasoningEffort: ReasoningEffort;
    maxTurns: number;
    projectAgents: boolean;
    globalAgents: boolean;
    projectSkills: boolean;
    userSkills: boolean;
    template?: string;
  } = {
    cwd: process.cwd(),
    model: DEFAULT_MODEL,
    reasoningEffort: DEFAULT_AGENT_REASONING_EFFORT,
    maxTurns: DEFAULT_MAX_TURNS,
    projectAgents: false,
    globalAgents: false,
    projectSkills: false,
    userSkills: false,
  };

  let i = 0;
  while (i < argv.length) {
    switch (argv[i]) {
      case "--cwd":
        opts.cwd = resolve(argv[++i]!);
        break;
      case "--resume":
        opts.resume = argv[++i];
        break;
      case "--model":
        opts.model = argv[++i]!;
        break;
      case "--effort": {
        const v = argv[++i]! as ReasoningEffort;
        if (v !== "high" && v !== "max" && v !== "off") {
          console.error("--effort must be high, max, or off");
          process.exit(1);
        }
        opts.reasoningEffort = v;
        break;
      }
      case "--max-turns":
        opts.maxTurns = parseInt(argv[++i]!, 10);
        break;
      case "--agents":
        opts.projectAgents = true;
        break;
      case "--global-agents":
        opts.globalAgents = true;
        break;
      case "--skills":
        opts.projectSkills = true;
        break;
      case "--user-skills":
        opts.userSkills = true;
        break;
      case "--template":
      case "-T":
        opts.template = argv[++i];
        break;
      default:
        console.error(`Unknown flag: ${argv[i]}`);
        process.exit(1);
    }
    i++;
  }
  return opts;
}

if (!process.env.DEEPSEEK_API_KEY) {
  console.error("Set DEEPSEEK_API_KEY in .env or environment.");
  process.exit(1);
}

const opts = parseArgs(process.argv.slice(2));

// A template document replaces the default coding-agent system prompt.
const system = opts.template
  ? loadTemplate(opts.template, { cwd: opts.cwd })
  : undefined;

const skills = opts.projectSkills || opts.userSkills
  ? discoverSkills({
      cwd: opts.cwd,
      includeProject: opts.projectSkills,
      includeUser: opts.userSkills,
    })
  : undefined;
const agentsMd = opts.projectAgents || opts.globalAgents
  ? { includeProject: opts.projectAgents, global: opts.globalAgents }
  : false;
const session = AgentSession.open({
  cwd: opts.cwd,
  resume: opts.resume,
  model: opts.model,
  reasoningEffort: opts.reasoningEffort,
  system,
  agentsMd,
  skills,
});

render(<App session={session} maxTurns={opts.maxTurns} />);
