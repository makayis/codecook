import type { LlmClient } from "./types";

export const PROBE_OUTPUT_TOKENS = 64;
const PROBE_TIMEOUT_MS = 20_000;
const PROBE_CONCURRENCY = 4;

export type ProbeFailure = "drop" | "retry" | "aborted" | "fatal";
export type ProbeCall = "ok" | ProbeFailure;

export function classifyProbeFailure(error: string, timedOut: boolean, stopped: boolean): ProbeFailure {
  if (stopped) {
    return "aborted";
  }
  if (/HTTP 401\b/.test(error)) {
    return "fatal";
  }
  if (/HTTP 400\b|HTTP 403\b|HTTP 404\b/.test(error)) {
    return "drop";
  }
  if (timedOut) {
    return "retry";
  }
  if (/HTTP 429\b|HTTP 500\b|HTTP 502\b|HTTP 503\b|HTTP 504\b/.test(error)) {
    return "retry";
  }
  if (error === "Cancelled" || /timeout|timed out|network|fetch failed/i.test(error)) {
    return "retry";
  }
  return "drop";
}

export interface ProbeUpdate {
  done: number;
  total: number;
  failed: number;
  working: string[];
  failedIds: string[];
  fatal?: string;
}

export async function probeModel(client: LlmClient, modelId: string, stop: AbortSignal): Promise<{ call: ProbeCall; error?: string }> {
  const first = await probeOnce(client, modelId, stop);
  if (first.call !== "retry") {
    return first;
  }
  if (stop.aborted) {
    return { call: "aborted" };
  }
  const second = await probeOnce(client, modelId, stop);
  if (second.call === "ok" || second.call === "aborted" || second.call === "fatal") {
    return second;
  }
  return { call: "drop", error: second.error };
}

export async function probeModelIds(
  client: LlmClient,
  ids: string[],
  stop: AbortSignal,
  onUpdate: (update: ProbeUpdate) => void
): Promise<void> {
  let next = 0;
  let done = 0;
  let failed = 0;
  let fatal: string | undefined;
  const working: string[] = [];
  const failedIds: string[] = [];
  const report = () => onUpdate({ done, total: ids.length, failed, working: [...working], failedIds: [...failedIds], fatal });

  async function worker(): Promise<void> {
    while (!stop.aborted && !fatal) {
      const index = next++;
      if (index >= ids.length) {
        return;
      }
      const result = await probeModel(client, ids[index], stop);
      if (result.call === "aborted" || stop.aborted) {
        return;
      }
      done += 1;
      if (result.call === "ok") {
        working.push(ids[index]);
      } else if (result.call === "fatal") {
        failed += 1;
        failedIds.push(ids[index]);
        fatal = result.error || "The key was rejected.";
      } else {
        failed += 1;
        failedIds.push(ids[index]);
      }
      report();
      if (fatal) {
        return;
      }
    }
  }

  const workers = Math.min(PROBE_CONCURRENCY, ids.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
}

async function probeOnce(client: LlmClient, modelId: string, stop: AbortSignal): Promise<{ call: ProbeCall; error?: string }> {
  const link = linkAbort(stop, PROBE_TIMEOUT_MS);
  try {
    for await (const event of client.streamChat([{ role: "user", content: "Reply with hi" }], undefined, modelId, link.signal)) {
      if (event.type === "error") {
        return { call: classifyProbeFailure(event.error, link.timedOut(), stop.aborted), error: event.error };
      }
      if (event.type === "done") {
        return { call: "ok" };
      }
    }
    return { call: "drop" };
  } finally {
    link.cancel();
  }
}

function linkAbort(stop: AbortSignal, ms: number): { signal: AbortSignal; timedOut: () => boolean; cancel: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const onStop = () => ctrl.abort();
  if (stop.aborted) {
    ctrl.abort();
  } else {
    stop.addEventListener("abort", onStop, { once: true });
  }
  return {
    signal: ctrl.signal,
    timedOut: () => ctrl.signal.aborted && !stop.aborted,
    cancel: () => {
      clearTimeout(timer);
      stop.removeEventListener("abort", onStop);
    },
  };
}
