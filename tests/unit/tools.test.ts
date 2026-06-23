import { describe, expect, it, vi } from "vitest";
import { ToolRegistry, tool } from "../../src/tools.js";

const echo = tool({
  name: "echo",
  description: "Echo a value",
  parameters: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
  },
  execute: ({ value }) => value as string,
});

describe("ToolRegistry", () => {
  it("registers and retrieves a tool", () => {
    const registry = new ToolRegistry();
    registry.register(echo);

    expect(registry.get("echo")).toBe(echo);
    expect(registry.has("echo")).toBe(true);
    expect(registry.size).toBe(1);
  });

  it("returns string results directly", async () => {
    const registry = new ToolRegistry();
    registry.register(echo);

    await expect(registry.execute("echo", { value: "hello" })).resolves.toBe("hello");
  });

  it("serializes non-string results", async () => {
    const registry = new ToolRegistry();
    registry.register({ ...echo, execute: () => ({ ok: true }) });

    await expect(registry.execute("echo", {})).resolves.toBe('{"ok":true}');
  });

  it("returns an error for an unknown tool", async () => {
    const registry = new ToolRegistry();

    await expect(registry.execute("missing", {})).resolves.toBe(
      "Error: Unknown tool 'missing'",
    );
  });

  it("converts thrown errors to result strings", async () => {
    const registry = new ToolRegistry();
    registry.register({ ...echo, execute: vi.fn(() => { throw new Error("boom"); }) });

    await expect(registry.execute("echo", {})).resolves.toBe(
      "Error executing echo: boom",
    );
  });

  it("returns the aborted marker when an aborted execution throws", async () => {
    const registry = new ToolRegistry();
    const controller = new AbortController();
    controller.abort();
    registry.register({ ...echo, execute: vi.fn(() => { throw new Error("aborted"); }) });

    await expect(registry.execute("echo", {}, controller.signal)).resolves.toBe("[aborted]");
  });

  it("produces OpenAI-compatible specs without execute", () => {
    const registry = new ToolRegistry();
    registry.register(echo);

    expect(registry.toOpenAISpecs()).toEqual([
      {
        type: "function",
        function: {
          name: "echo",
          description: "Echo a value",
          parameters: echo.parameters,
        },
      },
    ]);
  });
});
