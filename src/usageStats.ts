import type { MonthUsage, PeriodKind, PeriodSpend, Settings, TaskType, TaskUsage, UsageRecord } from "./types";

const TASKS: TaskType[] = ["chat", "plan", "generate", "refactor", "agent"];

export function emptyTask(): Record<TaskType, TaskUsage> {
  return {
    chat: { tokens: 0, costUsd: 0, count: 0 },
    plan: { tokens: 0, costUsd: 0, count: 0 },
    generate: { tokens: 0, costUsd: 0, count: 0 },
    refactor: { tokens: 0, costUsd: 0, count: 0 },
    agent: { tokens: 0, costUsd: 0, count: 0 },
  };
}

export function monthKey(ts = Date.now()): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function summarizeRecords(records: UsageRecord[], key = monthKey()): MonthUsage {
  const byTask = emptyTask();
  let tokens = 0;
  let costUsd = 0;
  let saved = 0;
  let used = 0;
  for (const row of records) {
    const t = (row.prompt || 0) + (row.completion || 0);
    tokens += t;
    costUsd += row.costUsd || 0;
    saved += row.saved || 0;
    used += row.used || t;
    const bucket = byTask[row.taskType] ?? byTask.agent;
    bucket.tokens += t;
    bucket.costUsd += row.costUsd || 0;
    bucket.count += 1;
  }
  return { key, tokens, costUsd, saved, used, byTask };
}

export function summarizeMonth(records: UsageRecord[], key = monthKey()): MonthUsage {
  return summarizeRecords(
    records.filter((r) => monthKey(r.ts) === key),
    key
  );
}

export function emptyMonth(key = monthKey()): MonthUsage {
  return { key, tokens: 0, costUsd: 0, saved: 0, used: 0, byTask: emptyTask() };
}

export function knownTasks(): TaskType[] {
  return TASKS;
}

export function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function startOfIsoWeek(ts: number): number {
  const d = new Date(startOfDay(ts));
  const day = d.getDay();
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  return d.getTime();
}

export function startOfMonth(ts: number): number {
  const d = new Date(ts);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function periodBounds(kind: PeriodKind, now = Date.now()): { start: number; end: number; key: string } {
  if (kind === "day") {
    const start = startOfDay(now);
    const end = start + 24 * 60 * 60 * 1000;
    return { start, end, key: new Date(start).toISOString().slice(0, 10) };
  }
  if (kind === "week") {
    const start = startOfIsoWeek(now);
    const end = start + 7 * 24 * 60 * 60 * 1000;
    return { start, end, key: weekKey(start) };
  }
  const start = startOfMonth(now);
  const d = new Date(start);
  d.setMonth(d.getMonth() + 1);
  return { start, end: d.getTime(), key: monthKey(start) };
}

export function weekKey(start: number): string {
  const d = new Date(start);
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(((start - jan1.getTime()) / 86400000 + jan1.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function costInRange(records: UsageRecord[], start: number, end: number): number {
  return records.reduce((n, r) => (r.ts >= start && r.ts < end ? n + (r.costUsd || 0) : n), 0);
}

export function forecastSpend(used: number, start: number, end: number, now = Date.now()): number {
  const elapsed = now - start;
  const total = Math.max(1, end - start);
  if (elapsed < 15 * 60 * 1000) {
    return used;
  }
  const frac = Math.min(1, Math.max(elapsed / total, 1 / 24));
  return used / frac;
}

export function periodSnapshots(records: UsageRecord[], settings: Pick<Settings, "spendLimitDailyUsd" | "spendLimitWeeklyUsd" | "spendLimitMonthlyUsd">, now = Date.now()): PeriodSpend[] {
  const limits: Record<PeriodKind, number> = {
    day: settings.spendLimitDailyUsd || 0,
    week: settings.spendLimitWeeklyUsd || 0,
    month: settings.spendLimitMonthlyUsd || 0,
  };
  return (["day", "week", "month"] as PeriodKind[]).map((kind) => {
    const { start, end } = periodBounds(kind, now);
    const used = costInRange(records, start, end);
    const limit = limits[kind];
    const left = limit > 0 ? Math.max(0, limit - used) : null;
    const forecast = forecastSpend(used, start, end, now);
    const pct = limit > 0 ? (used / limit) * 100 : 0;
    return { kind, used, limit, left, forecast, pct };
  });
}

export function warnLevel(pct: number): 0 | 80 | 100 {
  if (pct >= 100) {
    return 100;
  }
  if (pct >= 80) {
    return 80;
  }
  return 0;
}
