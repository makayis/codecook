export interface ProviderUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_tokens: number;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function detailCached(usage: Record<string, unknown>, key: string): number {
  const details = usage[key];
  if (!details || typeof details !== "object") {
    return 0;
  }
  return num((details as { cached_tokens?: unknown }).cached_tokens);
}

export function readProviderUsage(provider: string, usage: Record<string, unknown> | undefined): ProviderUsage {
  const row = usage ?? {};
  if (provider === "openai-responses") {
    const prompt = num(row.input_tokens);
    const completion = num(row.output_tokens);
    const cached = Math.min(prompt, detailCached(row, "input_tokens_details"));
    return {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: num(row.total_tokens) || prompt + completion,
      cached_tokens: cached,
    };
  }
  if (provider === "anthropic") {
    const fresh = num(row.input_tokens);
    const cached = num(row.cache_read_input_tokens);
    const written = num(row.cache_creation_input_tokens);
    const prompt = fresh + cached + written;
    const completion = num(row.output_tokens);
    return {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
      cached_tokens: Math.min(cached, prompt),
    };
  }
  if (provider === "aws") {
    const fresh = num(row.inputTokens);
    const cached = num(row.cacheReadInputTokens);
    const written = num(row.cacheWriteInputTokens);
    const prompt = fresh + cached + written;
    const completion = num(row.outputTokens);
    return {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: Math.max(num(row.totalTokens), prompt + completion),
      cached_tokens: Math.min(cached, prompt),
    };
  }
  const prompt = num(row.prompt_tokens);
  const completion = num(row.completion_tokens);
  const cached = Math.min(prompt, detailCached(row, "prompt_tokens_details"));
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: num(row.total_tokens) || prompt + completion,
    cached_tokens: cached,
  };
}
