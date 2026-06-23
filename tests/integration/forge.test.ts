import { describe, expect, it, vi } from "vitest";
import { MAX_TURNS_REACHED } from "../../src/defaults.js";
import { Forge } from "../../src/forge.js";
import { tool } from "../../src/tools.js";

function completion(message: Record<string, unknown>) {
  return {
    id: "completion-1",
    object: "chat.completion",
    created: 0,
    model: "test-model",
    choices: [{ index: 0, finish_reason: "stop", logprobs: null, message }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

async function* chunks(items: Array<Record<string, unknown>>) {
  for (const item of items) yield item;
}

function createForge(execute = vi.fn(() => "tool result")) {
  return {
    execute,
    forge: new Forge({
      apiKey: "test-key",
      model: "test-model",
      tools: [
        tool({
          name: "lookup",
          description: "Look up a value",
          parameters: { type: "object" },
          execute,
        }),
      ],
    }),
  };
}

describe("Forge.chat()", () => {
  it("sends the user message and returns the assistant reply", async () => {
    const { forge } = createForge();
    const create = vi
      .spyOn(forge.client.chat.completions, "create")
      .mockResolvedValue(completion({ role: "assistant", content: "hello" }) as never);

    await expect(forge.chat("hi")).resolves.toBe("hello");

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(forge.context.last()).toEqual({ role: "assistant", content: "hello" });
  });

  it("returns tool calls as JSON without executing them", async () => {
    const { forge, execute } = createForge();
    vi.spyOn(forge.client.chat.completions, "create").mockResolvedValue(
      completion({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "lookup", arguments: '{"value":1}' },
          },
        ],
      }) as never,
    );

    const result = await forge.chat("look it up");

    expect(JSON.parse(result)).toEqual([
      {
        id: "call-1",
        type: "function",
        function: { name: "lookup", arguments: '{"value":1}' },
      },
    ]);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("Forge.run()", () => {
  it("executes tools until the model returns a final answer", async () => {
    const { forge, execute } = createForge();
    const create = vi
      .spyOn(forge.client.chat.completions, "create")
      .mockResolvedValueOnce(
        completion({
          role: "assistant",
          content: null,
          reasoning_content: "need lookup",
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "lookup", arguments: '{"value":1}' },
            },
          ],
        }) as never,
      )
      .mockResolvedValueOnce(
        completion({ role: "assistant", content: "final answer" }) as never,
      );

    await expect(forge.run("question")).resolves.toBe("final answer");

    expect(execute).toHaveBeenCalledWith({ value: 1 }, undefined);
    expect(forge.context.toList().map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(create.mock.calls[1]![0]).toEqual(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "assistant",
            reasoning_content: "need lookup",
          }),
          expect.objectContaining({
            role: "tool",
            content: "tool result",
            tool_call_id: "call-1",
          }),
        ]),
      }),
    );
  });

  it("stops after maxTurns and retains the tool result", async () => {
    const { forge } = createForge();
    vi.spyOn(forge.client.chat.completions, "create").mockResolvedValue(
      completion({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "lookup", arguments: "{}" },
          },
        ],
      }) as never,
    );

    await expect(forge.run("question", 1)).resolves.toBe(MAX_TURNS_REACHED);
    expect(forge.context.last()).toEqual({
      role: "tool",
      content: "tool result",
      tool_call_id: "call-1",
      name: "lookup",
    });
  });
});

describe("Forge.runStream()", () => {
  it("emits text, tool lifecycle, and turn completion events", async () => {
    const { forge } = createForge();
    vi.spyOn(forge.client.chat.completions, "create")
      .mockResolvedValueOnce(
        chunks([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call-1",
                      function: { name: "lookup", arguments: '{"value":' },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              { delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] } },
            ],
          },
        ]) as never,
      )
      .mockResolvedValueOnce(
        chunks([
          { choices: [{ delta: { content: "final " } }] },
          { choices: [{ delta: { content: "answer" } }] },
        ]) as never,
      );

    const events = [];
    for await (const event of forge.runStream("question")) events.push(event);

    expect(events).toEqual([
      {
        type: "tool_call_start",
        id: "call-1",
        name: "lookup",
        arguments: '{"value":1}',
      },
      {
        type: "tool_result",
        id: "call-1",
        name: "lookup",
        result: "tool result",
      },
      { type: "text_delta", delta: "final " },
      { type: "text_delta", delta: "answer" },
      { type: "turn_done", content: "final answer" },
    ]);
  });
});
