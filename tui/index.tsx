#!/usr/bin/env npx tsx
/**
 * Agent TUI — multi-turn chat with streaming (Claude Code style).
 *
 * Usage:
 *   npm run tui
 *   npm run tui -- --cwd /path/to/project
 *   npm run tui -- --resume trajectories/task.json
 */

import React from "react";
import { render } from "ink";
import { resolve } from "node:path";
import { AgentSession } from "../src/index.js";
import App from "./app.js";

function parseArgs(argv: string[]) {
  const opts: {
    cwd: string;
    resume?: string;
    model: string;
    maxTurns: number;
  } = {
    cwd: process.cwd(),
    model: "deepseek-chat",
    maxTurns: 20,
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
      case "--max-turns":
        opts.maxTurns = parseInt(argv[++i]!, 10);
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
const session = AgentSession.open({
  cwd: opts.cwd,
  resume: opts.resume,
  model: opts.model,
});

render(<App session={session} maxTurns={opts.maxTurns} />);
