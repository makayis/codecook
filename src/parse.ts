export function parseToolArgs(rawArgs: string): Record<string, unknown> {
  if (!rawArgs || !rawArgs.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(rawArgs);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Expected object, got ${typeof parsed}`);
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Malformed tool arguments: ${err}\nRaw: ${rawArgs.slice(0, 500)}`);
  }
}
