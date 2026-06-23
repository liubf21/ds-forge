/** ds-forge defaults — single source of truth for all tunables. */

import type { ReasoningEffort } from "./types.js";

export const DEFAULT_MODEL = "deepseek-v4-flash";
export const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";
export const DEFAULT_MAX_TURNS = 2000;
/** Soft input budget for V4's 1M context window; leaves room for tools and estimation error. */
export const DEFAULT_MAX_TOKENS = 900_000;
/** After crossing the high watermark, evict enough history to restore cache-stable headroom. */
export const DEFAULT_TRUNCATE_TARGET_TOKENS = Math.floor(DEFAULT_MAX_TOKENS * 2 / 3);
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Sentinel returned when agent loop exhausts maxTurns. */
export const MAX_TURNS_REACHED = "[Max turns reached]";

/** Default effort when tools are registered (agent mode). */
export const DEFAULT_AGENT_REASONING_EFFORT: ReasoningEffort = "high";

export function resolveReasoningEffort(
  explicit: ReasoningEffort | undefined,
  hasTools: boolean,
): ReasoningEffort {
  if (explicit !== undefined) return explicit;
  return hasTools ? DEFAULT_AGENT_REASONING_EFFORT : "off";
}

/** Merge V4 thinking params with caller overrides. */
export function buildModelExtra(
  effort: ReasoningEffort,
  userExtra?: Record<string, unknown>,
): Record<string, unknown> {
  const base: Record<string, unknown> =
    effort === "off"
      ? { extra_body: { thinking: { type: "disabled" } } }
      : {
          reasoning_effort: effort,
          extra_body: { thinking: { type: "enabled" } },
        };

  if (!userExtra) return base;

  const merged = { ...base, ...userExtra };
  if (base.extra_body && userExtra.extra_body) {
    merged.extra_body = {
      ...(base.extra_body as object),
      ...(userExtra.extra_body as object),
    };
  }
  return merged;
}
