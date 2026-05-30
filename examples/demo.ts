#!/usr/bin/env npx tsx
/**
 * Demo of ds-forge features.
 *
 * Usage:
 *   export DEEPSEEK_API_KEY=sk-...
 *   npx tsx examples/demo.ts
 */

import { Forge, tool } from "../src/index.js";

const getWeather = tool({
  name: "get_weather",
  description: "Get current weather for a city.",
  parameters: {
    type: "object",
    properties: {
      city: { type: "string", description: "Name of the city." },
      unit: {
        type: "string",
        enum: ["celsius", "fahrenheit"],
        description: "Temperature unit.",
      },
    },
    required: ["city"],
  },
  execute: async (args) => {
    const temps: Record<string, number> = { Paris: 22, Tokyo: 28, Beijing: 30 };
    const city = String(args.city);
    const unit = args.unit ?? "celsius";
    let temp = temps[city] ?? 20;
    if (unit === "fahrenheit") temp = Math.round((temp * 9) / 5 + 32);
    const symbol = unit === "celsius" ? "°C" : "°F";
    return `Weather in ${city}: ${temp}${symbol}, sunny`;
  },
});

const calculate = tool({
  name: "calculate",
  description: "Evaluate a mathematical expression.",
  parameters: {
    type: "object",
    properties: {
      expr: {
        type: "string",
        description: "A math expression like '3 * 4 + 2'.",
      },
    },
    required: ["expr"],
  },
  execute: async (args) => {
    try {
      return String(eval(String(args.expr)));
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

async function main() {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    console.error("Set DEEPSEEK_API_KEY to run this demo.");
    process.exit(1);
  }

  const tools = [getWeather, calculate];

  // ── 1. Single turn ──────────────────────────────────
  console.log("=".repeat(60));
  console.log("1. SINGLE TURN");
  console.log("=".repeat(60));

  const forge = new Forge({
    apiKey,
    system: "You are a concise assistant. Answer in one sentence.",
  });
  const resp1 = await forge.chat("What is 2 + 3?");
  console.log(`Response: ${resp1}\n`);

  // ── 2. Agent loop ───────────────────────────────────
  console.log("=".repeat(60));
  console.log("2. AGENT LOOP (tool calling)");
  console.log("=".repeat(60));

  const forge2 = new Forge({
    apiKey,
    system: "You are a helpful assistant. Use tools when needed.",
    tools,
  });
  const result = await forge2.run(
    "What's the weather in Paris? Then multiply the temperature in Celsius by 2.",
  );
  console.log(`Result: ${result}\n`);

  // ── 3. Save & Load ──────────────────────────────────
  console.log("=".repeat(60));
  console.log("3. SAVE & LOAD");
  console.log("=".repeat(60));

  const tmpPath = `/tmp/ds_forge_session_${Date.now()}.json`;
  forge2.save(tmpPath);
  console.log(`Saved to ${tmpPath}`);
  console.log(`Messages saved: ${forge2.context.messages.length}`);

  const forge3 = Forge.load(tmpPath, { tools });
  console.log(`Loaded: ${forge3.context.messages.length} messages restored\n`);

  // ── 4. Resume ───────────────────────────────────────
  console.log("=".repeat(60));
  console.log("4. RESUME");
  console.log("=".repeat(60));

  const result2 = await forge3.resume("Now check Tokyo too.");
  console.log(`Result: ${result2}\n`);

  // ── 5. Debug ────────────────────────────────────────
  console.log("=".repeat(60));
  console.log("5. DEBUG (stateless replay)");
  console.log("=".repeat(60));

  const debugPath = `/tmp/ds_forge_debug_${Date.now()}.json`;
  const { writeFileSync, unlinkSync } = await import("node:fs");
  writeFileSync(
    debugPath,
    JSON.stringify([
      { role: "system", content: "You are a poet. Reply in haiku." },
      { role: "user", content: "Write about code." },
    ]),
  );

  const msg = await Forge.debug(debugPath, { apiKey });
  console.log(`Role: ${msg.role}`);
  console.log(`Content: ${msg.content}`);

  // Cleanup
  unlinkSync(tmpPath);
  unlinkSync(debugPath);
  console.log("\nDone.");
}

main().catch((e) => {
  console.error("Demo failed:", e);
  process.exit(1);
});
