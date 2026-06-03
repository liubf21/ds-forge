/** Per API call usage snapshot (DeepSeek OpenAI-compatible `usage` object). */

export interface UsageRecord {
  /** 0-based index of this model call in the session. */
  turn: number;
  at: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_cache_hit_tokens: number;
  prompt_cache_miss_tokens: number;
  reasoning_tokens?: number;
}

export function parseUsageLog(raw: unknown): UsageRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: UsageRecord[] = [];
  for (const item of raw) {
    const rec = parseUsageRecord(item);
    if (rec) out.push(rec);
  }
  return out;
}

function parseUsageRecord(item: unknown): UsageRecord | null {
  if (!item || typeof item !== "object") return null;
  const o = item as Record<string, unknown>;
  const turn = Number(o.turn);
  const at = typeof o.at === "string" ? o.at : "";
  const prompt = Number(o.prompt_tokens ?? 0);
  const completion = Number(o.completion_tokens ?? 0);
  const total = Number(o.total_tokens ?? prompt + completion);
  const hit = Number(o.prompt_cache_hit_tokens ?? 0);
  const miss =
    o.prompt_cache_miss_tokens != null
      ? Number(o.prompt_cache_miss_tokens)
      : Math.max(0, prompt - hit);
  const reasoning =
    o.reasoning_tokens != null ? Number(o.reasoning_tokens) : undefined;
  if (!Number.isFinite(turn) || !at) return null;
  return {
    turn,
    at,
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    prompt_cache_hit_tokens: hit,
    prompt_cache_miss_tokens: miss,
    ...(reasoning != null && Number.isFinite(reasoning)
      ? { reasoning_tokens: reasoning }
      : {}),
  };
}

export function parseUsage(
  raw: Record<string, unknown> | undefined | null,
  turn: number,
): UsageRecord | null {
  if (!raw) return null;

  const prompt = Number(raw.prompt_tokens ?? 0);
  const completion = Number(raw.completion_tokens ?? 0);
  const total = Number(raw.total_tokens ?? prompt + completion);
  const hit = Number(raw.prompt_cache_hit_tokens ?? 0);
  const miss =
    raw.prompt_cache_miss_tokens != null
      ? Number(raw.prompt_cache_miss_tokens)
      : Math.max(0, prompt - hit);

  let reasoning: number | undefined;
  const details = raw.completion_tokens_details;
  if (details && typeof details === "object") {
    const rt = (details as Record<string, unknown>).reasoning_tokens;
    if (rt != null) reasoning = Number(rt);
  }
  if (raw.reasoning_tokens != null) {
    reasoning = Number(raw.reasoning_tokens);
  }

  return {
    turn,
    at: new Date().toISOString(),
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    prompt_cache_hit_tokens: hit,
    prompt_cache_miss_tokens: miss,
    ...(reasoning != null && Number.isFinite(reasoning)
      ? { reasoning_tokens: reasoning }
      : {}),
  };
}
