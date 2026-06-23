import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_TRUNCATE_TARGET_TOKENS,
} from "../../src/defaults.js";
import { Forge } from "../../src/forge.js";
import { Context } from "../../src/context.js";

describe("context defaults", () => {
  it("uses a 900K soft budget for the V4 1M context window", () => {
    expect(DEFAULT_MAX_TOKENS).toBe(900_000);
    expect(DEFAULT_TRUNCATE_TARGET_TOKENS).toBe(600_000);
    expect(new Context().maxTokens).toBe(DEFAULT_MAX_TOKENS);
    expect(new Context().truncateTargetTokens).toBe(DEFAULT_TRUNCATE_TARGET_TOKENS);
  });

  it("derives the low watermark from a custom Forge maxTokens", () => {
    const forge = new Forge({ apiKey: "test-key", maxTokens: 300_000 });

    expect(forge.context.maxTokens).toBe(300_000);
    expect(forge.context.truncateTargetTokens).toBe(200_000);
  });
});
