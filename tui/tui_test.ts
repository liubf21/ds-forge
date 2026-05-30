#!/usr/bin/env npx tsx
/**
 * TUI test suite — pure logic only, no Ink render, no API calls.
 *
 * Run:
 * Run: npm run test (via root test suite)
 */

import assert from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentSession } from "../src/agent-session.js";
import type { StreamEvent } from "../src/types.js";
import { chatReducer, visibleHistory, MAX_VISIBLE_MESSAGES } from "./chat-state.js";
import { applyEvent, formatToolCommand, formatToolStatus } from "./display.js";
import { historyFromContext } from "./history.js";
import { fileUrl, linkText } from "./links.js";

const VERBOSE = !!process.env.TUI_TEST_VERBOSE;
const TEST_KEY = "test-key";
const TEST_CWD = "/tmp/ds-forge-tui-test";

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void | Promise<void>) {
  return async () => {
    try {
      await fn();
      passed++;
      if (VERBOSE) console.log(`  ✓ ${name}`);
    } catch (e) {
      failed++;
      console.error(`\n  ✗ FAIL [${name}]`);
      console.error(`    ${(e as Error).message}`);
    }
  };
}

const emptyTurn = () => ({ content: "", tools: [] as Array<{ id: string; name: string; args: string; result?: string; running: boolean }> });

function test_applyEvent_stream_lifecycle() {
  let turn = emptyTurn();
  turn = applyEvent(turn, { type: "text_delta", delta: "Hello" });
  turn = applyEvent(turn, { type: "text_delta", delta: " world" });
  assert.equal(turn.content, "Hello world");

  turn = applyEvent(turn, {
    type: "tool_call_start",
    id: "c1",
    name: "bash",
    arguments: '{"command":"ls"}',
  });
  assert.equal(turn.tools.length, 1);
  assert.equal(turn.tools[0]!.running, true);

  turn = applyEvent(turn, { type: "tool_result", id: "c1", name: "bash", result: "a\nb\n" });
  assert.equal(turn.tools[0]!.running, false);
  assert.equal(turn.tools[0]!.result, "a\nb\n");
}

function test_applyEvent_ignores_turn_done() {
  const turn = emptyTurn();
  const next = applyEvent(turn, { type: "turn_done", content: "ignored" });
  assert.deepEqual(next, turn);
}

function test_chatReducer_complete_turn_clears_live() {
  let state = chatReducer({ history: [], live: { content: "partial", tools: [] } }, {
    type: "complete_turn",
    message: { role: "assistant", content: "done", tools: [] },
  });
  assert.equal(state.live, null);
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0]?.role, "assistant");
}

function test_stream_to_history_no_duplicate_live() {
  // Simulates turn completion: live must not coexist with history entry.
  const events: StreamEvent[] = [
    { type: "text_delta", delta: "Answer" },
    { type: "tool_call_start", id: "t1", name: "bash", arguments: '{"command":"pwd"}' },
    { type: "tool_result", id: "t1", name: "bash", result: TEST_CWD },
  ];

  let state = chatReducer({ history: [], live: null }, { type: "add_user", content: "where?" });
  let turn = emptyTurn();
  for (const ev of events) turn = applyEvent(turn, ev);
  state = chatReducer(state, {
    type: "complete_turn",
    message: { role: "assistant", content: turn.content, tools: turn.tools },
  });

  assert.equal(state.live, null);
  assert.equal(state.history.length, 2);
  const assistant = state.history[1];
  assert.equal(assistant?.role, "assistant");
  assert.equal(assistant?.role === "assistant" && assistant.tools[0]?.name, "bash");
}

function test_formatToolStatus_collapses_multiline() {
  assert.equal(formatToolStatus("line1\nline2\nline3", false), "✓ 3 lines");
  assert.equal(formatToolStatus("/short", false), "✓ /short");
  assert.equal(formatToolStatus(undefined, true), "…");
}

function test_formatToolCommand_bash_json() {
  assert.equal(formatToolCommand("bash", '{"command":"git status"}'), "git status");
}

function test_historyFromContext() {
  const history = historyFromContext([
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }],
    },
    { role: "tool", content: "ok", tool_call_id: "c1", name: "bash" },
    { role: "assistant", content: "done" },
  ]);

  assert.equal(history.length, 3);
  assert.equal(history[0]?.role, "user");
  assert.equal(history[1]?.role, "assistant");
  assert.equal(history[1]?.role === "assistant" && history[1].tools[0]?.result, "ok");
  assert.equal(history[2]?.role === "assistant" && history[2].content, "done");
}

function test_visibleHistory_caps() {
  const history = Array.from({ length: MAX_VISIBLE_MESSAGES + 5 }, (_, i) => ({
    role: "user" as const,
    content: String(i),
  }));
  const { hidden, items } = visibleHistory(history);
  assert.equal(hidden, 5);
  assert.equal(items.length, MAX_VISIBLE_MESSAGES);
  assert.equal(items[0]?.content, "5");
}

function test_terminal_links() {
  const path = "/Users/me/project";
  assert.equal(fileUrl(path), "file:///Users/me/project");
  const linked = linkText(fileUrl(path), path);
  assert.ok(linked.includes("file:///Users/me/project"));
  assert.ok(linked.includes(path));

  const spaced = "/Users/me/my project/foo#bar";
  assert.equal(fileUrl(spaced), "file:///Users/me/my%20project/foo%23bar");
}

function test_agentSession_clear_keeps_custom_system() {
  const session = AgentSession.open({
    apiKey: TEST_KEY,
    cwd: TEST_CWD,
    system: "CUSTOM_SYSTEM",
    tools: [],
  });
  session.forge.context.addUser("hello");
  session.clear();
  assert.equal(session.system, "CUSTOM_SYSTEM");
  assert.equal(session.forge.context.messages[0]?.content, "CUSTOM_SYSTEM");
  assert.equal(session.forge.context.messages.length, 1);
}

function test_agentSession_resume_reasoning_effort() {
  const trajDir = mkdtempSync(join(tmpdir(), "ds-forge-traj-"));
  const prev = process.env.DS_FORGE_DIR;
  process.env.DS_FORGE_DIR = trajDir;

  try {
    const trajPath = join(trajDir, "resume-effort.json");
    writeFileSync(
      trajPath,
      JSON.stringify({
        version: "0.1.0",
        model: "deepseek-v4-flash",
        system: "test",
        tools: [],
        messages: [{ role: "user", content: "hi" }],
        metadata: {},
      }),
    );

    const off = AgentSession.open({
      apiKey: TEST_KEY,
      cwd: TEST_CWD,
      resume: trajPath,
      reasoningEffort: "off",
      tools: [],
    });
    assert.equal(off.forge.reasoningEffort, "off");

    const max = AgentSession.open({
      apiKey: TEST_KEY,
      cwd: TEST_CWD,
      resume: trajPath,
      reasoningEffort: "max",
      tools: [],
    });
    assert.equal(max.forge.reasoningEffort, "max");
  } finally {
    if (prev === undefined) delete process.env.DS_FORGE_DIR;
    else process.env.DS_FORGE_DIR = prev;
  }
}

function test_agentSession_resume_system_override() {
  const trajDir = mkdtempSync(join(tmpdir(), "ds-forge-traj-"));
  const prev = process.env.DS_FORGE_DIR;
  process.env.DS_FORGE_DIR = trajDir;

  try {
    const trajPath = join(trajDir, "resume-test.json");
    writeFileSync(
      trajPath,
      JSON.stringify({
        version: "0.1.0",
        model: "deepseek-chat",
        system: "OLD_SYSTEM",
        tools: [],
        messages: [
          { role: "system", content: "OLD_SYSTEM" },
          { role: "user", content: "hi" },
        ],
        metadata: {},
      }),
    );

    const session = AgentSession.open({
      apiKey: TEST_KEY,
      cwd: TEST_CWD,
      resume: trajPath,
      system: "OVERRIDE",
      tools: [],
    });

    assert.equal(session.system, "OVERRIDE");
    assert.equal(session.forge.context.messages[0]?.content, "OVERRIDE");
  } finally {
    if (prev === undefined) delete process.env.DS_FORGE_DIR;
    else process.env.DS_FORGE_DIR = prev;
  }
}

async function main() {
  console.log("TUI Test Suite\n");

  await check("applyEvent stream lifecycle", test_applyEvent_stream_lifecycle)();
  await check("applyEvent ignores turn_done", test_applyEvent_ignores_turn_done)();
  await check("complete_turn clears live", test_chatReducer_complete_turn_clears_live)();
  await check("stream → history leaves no live", test_stream_to_history_no_duplicate_live)();
  await check("formatToolStatus collapses multiline", test_formatToolStatus_collapses_multiline)();
  await check("formatToolCommand bash JSON", test_formatToolCommand_bash_json)();
  await check("historyFromContext", test_historyFromContext)();
  await check("visibleHistory caps", test_visibleHistory_caps)();
  await check("terminal OSC 8 links", test_terminal_links)();
  await check("AgentSession.clear keeps custom system", test_agentSession_clear_keeps_custom_system)();
  await check("AgentSession resume reasoningEffort", test_agentSession_resume_reasoning_effort)();
  await check("AgentSession resume+system override", test_agentSession_resume_system_override)();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
