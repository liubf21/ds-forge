import { describe, expect, it } from "vitest";
import {
  Context,
  messagesForApi,
  normalizeAssistantFields,
} from "../../src/context.js";

function wordCounter(messages: Array<{ content?: string | null }>): number {
  return messages.reduce(
    (total, message) => total + (message.content?.split(/\s+/).filter(Boolean).length ?? 0),
    0,
  );
}

describe("Context.truncate()", () => {
  it("does not truncate before crossing the high watermark", () => {
    const context = new Context();
    context.tokenCounter = (messages) => messages.length;
    context.maxTokens = 3;
    context.truncateTargetTokens = 2;
    context.addSystem("system");
    context.addUser("question");
    context.addAssistant("answer");

    context.truncate();

    expect(context.length).toBe(3);
  });

  it("truncates to the low watermark after crossing the high watermark", () => {
    const context = new Context();
    context.tokenCounter = (messages) => messages.length;
    context.maxTokens = 6;
    context.truncateTargetTokens = 3;
    context.addSystem("system");
    context.addUser("old");
    context.addAssistant("old answer");
    context.addUser("middle");
    context.addAssistant("middle answer");
    context.addUser("new");
    context.addAssistant("new answer");

    context.truncate();

    expect(context.toList()).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "new" },
      { role: "assistant", content: "new answer" },
    ]);
    expect(context.tokenCount()).toBe(3);
  });

  it("removes the oldest complete non-system turn when over limit", () => {
    const context = new Context();
    context.tokenCounter = wordCounter;
    context.addSystem("system prompt");
    context.addUser("old question");
    context.addAssistant("old answer");
    context.addUser("new question");
    context.addAssistant("new answer");

    context.truncate(6);

    expect(context.toList()).toEqual([
      { role: "system", content: "system prompt" },
      { role: "user", content: "new question" },
      { role: "assistant", content: "new answer" },
    ]);
  });

  it("evicts an assistant tool call and all of its tool results together", () => {
    const context = new Context();
    context.tokenCounter = (messages) => messages.length;
    context.addSystem("system");
    context.addUser("old");
    context.addAssistant(
      null,
      [
        {
          id: "call-1",
          type: "function",
          function: { name: "lookup", arguments: "{}" },
        },
        {
          id: "call-2",
          type: "function",
          function: { name: "search", arguments: "{}" },
        },
      ],
      "thinking",
    );
    context.addToolResult("call-1", "result", "lookup");
    context.addToolResult("call-2", "result", "search");
    context.addAssistant("done");
    context.addUser("new");

    context.truncate(2);

    expect(context.toList()).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "new" },
    ]);
  });

  it("retains an assistant tool call and all of its tool results together", () => {
    const context = new Context();
    context.tokenCounter = (messages) => messages.length;
    context.addSystem("system");
    context.addUser("discard me");
    context.addAssistant("discard me too");
    context.addUser("tool turn");
    context.addAssistant(
      null,
      [
        {
          id: "call-1",
          type: "function",
          function: { name: "lookup", arguments: "{}" },
        },
      ],
      "thinking",
    );
    context.addToolResult("call-1", "result", "lookup");
    context.addAssistant("final");

    context.truncate(5);

    expect(context.toList()).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "tool turn" },
      {
        role: "assistant",
        reasoning_content: "thinking",
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "lookup", arguments: "{}" },
          },
        ],
      },
      { role: "tool", content: "result", tool_call_id: "call-1", name: "lookup" },
      { role: "assistant", content: "final" },
    ]);
  });

  it("treats consecutive assistant messages before the next user as one turn", () => {
    const context = new Context();
    context.tokenCounter = (messages) => messages.length;
    context.addSystem("system");
    context.addUser("old question");
    context.addAssistant("first assistant message");
    context.addAssistant("second assistant message");
    context.addUser("new question");
    context.addAssistant("new answer");

    context.truncate(3);

    expect(context.toList()).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "new question" },
      { role: "assistant", content: "new answer" },
    ]);
  });

  it("preserves the system message", () => {
    const context = new Context();
    context.tokenCounter = (messages) => messages.length;
    context.addSystem("system");
    context.addUser("old");

    context.truncate(1);

    expect(context.toList()).toEqual([{ role: "system", content: "system" }]);
  });

  it("throws when only system messages remain above the limit", () => {
    const context = new Context();
    context.tokenCounter = wordCounter;
    context.addSystem("too large");

    expect(() => context.truncate(1)).toThrow(/only system message/);
  });

  it("does nothing when within the limit", () => {
    const context = new Context();
    context.tokenCounter = (messages) => messages.length;
    context.addUser("hello");
    const before = context.toList();

    context.truncate(1);

    expect(context.toList()).toEqual(before);
  });
});

describe("normalizeAssistantFields()", () => {
  it("promotes reasoning_content to content when no tool calls exist", () => {
    expect(normalizeAssistantFields(null, undefined, "answer")).toEqual({
      content: "answer",
    });
  });

  it("keeps reasoning_content when tool calls exist", () => {
    const toolCalls = [
      {
        id: "call-1",
        type: "function" as const,
        function: { name: "lookup", arguments: "{}" },
      },
    ];

    expect(normalizeAssistantFields(null, toolCalls, "thinking")).toEqual({
      tool_calls: toolCalls,
      reasoning_content: "thinking",
    });
  });

  it("omits null content and absent tool calls", () => {
    expect(normalizeAssistantFields(null, undefined, null)).toEqual({});
  });
});

describe("messagesForApi()", () => {
  it("repairs a reasoning-only assistant message", () => {
    expect(
      messagesForApi([{ role: "assistant", reasoning_content: "answer" }]),
    ).toEqual([{ role: "assistant", content: "answer" }]);
  });

  it("passes tool messages through by reference", () => {
    const toolMessage = {
      role: "tool" as const,
      content: "result",
      tool_call_id: "call-1",
      name: "lookup",
    };

    expect(messagesForApi([toolMessage])[0]).toBe(toolMessage);
  });
});
