import { cacheDiscountUsd, estimateCostUsd, PRO_MODEL } from "./models";
import type { Settings, UsageRecord } from "./types";
import { summarizeMonth, summarizeRecords } from "./usageStats";

export function compressionPair(
  row: Pick<UsageRecord, "used" | "saved" | "historyFull" | "historySent">,
  ceiling = 0
): { without: number; with: number; saved: number } {
  const withTokens = Math.max(0, row.used || 0);
  const hasHistory = row.historyFull != null || row.historySent != null;
  const full = hasHistory ? Math.max(0, row.historyFull ?? 0) : withTokens + Math.max(0, row.saved || 0);
  const sent = hasHistory ? Math.max(0, row.historySent ?? 0) : withTokens;
  const rawWithout = Math.max(withTokens, withTokens - sent + full);
  const without = ceiling > 0 ? Math.min(ceiling, rawWithout) : rawWithout;
  return { without, with: withTokens, saved: Math.max(0, without - withTokens) };
}

function latestTurn(records: UsageRecord[]): UsageRecord | undefined {
  let latest: UsageRecord | undefined;
  for (const row of records) {
    if (row.kind === "summary") {
      continue;
    }
    latest = row;
  }
  return latest;
}

function summaryCostOf(records: UsageRecord[]): number {
  return records.reduce((n, row) => n + (row.kind === "summary" ? row.costUsd || 0 : 0), 0);
}

function ceilingOf(settings: { turnTokenCeiling?: number }): number {
  return Math.max(0, settings.turnTokenCeiling || 0);
}

export function sessionSavings(
  records: UsageRecord[],
  settings: Settings
): { savedTokens: number; savedUsd: number; cacheUsd: number; summaries: number } {
  let cacheUsd = 0;
  let summaries = 0;
  for (const row of records) {
    cacheUsd += cacheDiscountUsd(settings, row.model || PRO_MODEL, row.cached || 0, row.prompt || 0);
    if (row.kind === "summary") {
      summaries += 1;
    }
  }
  const latest = latestTurn(records);
  const pair = latest ? compressionPair(latest, ceilingOf(settings)) : { without: 0, with: 0, saved: 0 };
  const summaryCost = summaryCostOf(records);
  const gross = latest ? estimateCostUsd(settings, latest.model || PRO_MODEL, pair.saved, 0) : 0;
  return {
    savedTokens: pair.saved,
    savedUsd: Math.max(0, gross - summaryCost),
    cacheUsd: Math.max(0, cacheUsd),
    summaries,
  };
}

export function buildSavingsMarkdown(
  session: UsageRecord[],
  month: UsageRecord[],
  settings: Settings
): string {
  const sess = summarizeRecords(session, "session");
  const monthly = summarizeMonth(month);
  const ceiling = ceilingOf(settings);
  const latest = latestTurn(session);
  const pair = latest ? compressionPair(latest, ceiling) : { without: 0, with: 0, saved: 0 };
  const fewer = pair.without > 0 ? Math.round((pair.saved / pair.without) * 100) : 0;
  const summaryCost = summaryCostOf(session);
  const actualCost = session.reduce((n, r) => n + (r.costUsd || 0), 0);
  const savedUsd = latest
    ? Math.max(0, estimateCostUsd(settings, latest.model || PRO_MODEL, pair.saved, 0) - summaryCost)
    : 0;
  const lines = [
    "# CodeCook savings report",
    "",
    `Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`,
    "",
    "## This session",
    "",
    pair.without
      ? `The latest call sent **${Math.round(pair.with)}** tokens with compression. Without compression that prompt is **${Math.round(pair.without)}**. **${Math.round(pair.saved)}** input tokens were not sent (**${fewer}%**).`
      : sess.tokens
        ? "No compression comparison for this session yet."
        : "No token activity in this session yet.",
    "",
    `| Metric | Value |`,
    `| --- | ---: |`,
    `| Without compression | ${Math.round(pair.without)} |`,
    `| With compression | ${Math.round(pair.with)} |`,
    `| Tokens saved | ${Math.round(pair.saved)} |`,
    `| Summary cost | $${summaryCost.toFixed(4)} |`,
    `| Actual cost | $${actualCost.toFixed(4)} |`,
    `| Estimated $ saved | $${savedUsd.toFixed(4)} |`,
    "",
    `## Month ${monthly.key}`,
    "",
    monthly.tokens ? "Billed calls this month are below. Savings are the latest call, not a sum of every call." : "No usage recorded this month.",
    "",
    `| Task | Calls | Tokens | Cost |`,
    `| --- | ---: | ---: | ---: |`,
  ];
  for (const [task, row] of Object.entries(monthly.byTask)) {
    if (!row.count) {
      continue;
    }
    lines.push(`| ${task} | ${row.count} | ${Math.round(row.tokens)} | $${row.costUsd.toFixed(4)} |`);
  }
  lines.push(
    "",
    "_Without compression is the full prompt capped at the context window. With compression is the payload sent on the latest call. Estimated dollars are the input price of that one difference, minus the summary cost._",
    ""
  );
  return lines.join("\n");
}
