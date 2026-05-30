/** DeepSeek V4 defaults for ds-forge. */

import type { ReasoningEffort } from "./types.js";

export const DEFAULT_MODEL = "deepseek-v4-flash";
export const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";

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
