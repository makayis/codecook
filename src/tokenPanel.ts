import * as vscode from "vscode";
import { loadSettings, saveSpendLimits } from "./config";
import { estimateCostUsd, estimateDisplayCostUsd, formatUsd, PRO_MODEL } from "./models";
import { buildSavingsMarkdown, compressionPair, sessionSavings } from "./savings";
import type { TokenStats, TurnEvent, UsageRecord } from "./types";
import { UsageStore } from "./usageStore";
import { emptyMonth, periodSnapshots } from "./usageStats";

export interface TokenSnapshot {
  contextPercent: number;
  savedPercent: number;
  cachePercent: number;
  cacheVisible: boolean;
  activity: string;
  model: string;
  savedLegend: string;
  cacheLegend: string;
  savedTurn: string;
  withoutTokens: string;
  withTokens: string;
  withoutPct: number;
  withPct: number;
  costTurn: string;
  sessionTokens: string;
  sessionUsd: string;
  contextLabel: string;
  contextPct: number;
  month: string;
  monthClass: string;
  monthPct: number;
  projected: string;
  user: string;
  prompt: string;
  output: string;
  cached: string;
  withoutCache: string;
  sessionCache: string;
  summaries: string;
  limit: number;
}

export class TokenPanel implements vscode.WebviewViewProvider {
  public static readonly viewId = "codecook.tokens";
  private view?: vscode.WebviewView;
  private stats: TokenStats = {
    percent: 0,
    used: 0,
    budget: 250000,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    cached_tokens: 0,
    saved: 0,
    saved_truncation: 0,
    saved_history: 0,
    elided: 0,
    costUsd: 0,
    model: "",
    taskType: "",
    month: emptyMonth(),
    recentCosts: [],
    periods: [],
    rules_tokens: 0,
    tools_tokens: 0,
    user_tokens: 0,
    historyFull: 0,
    historySent: 0,
    sessionSavedTokens: 0,
    sessionSavedUsd: 0,
    sessionCacheUsd: 0,
    sessionSummaries: 0,
  };
  private activity = "";
  private expanded = false;
  private statsChatId?: string;

  constructor(
    private readonly usage: UsageStore,
    private readonly activeChatId: () => string | undefined,
    private readonly onSummarize: () => void,
    private readonly onSnapshot?: (snapshot: TokenSnapshot) => void
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.onDidReceiveMessage((msg: { type?: string; daily?: number; weekly?: number; monthly?: number }) => {
      if (msg.type === "savingsReport") {
        void this.openSavingsReport();
      }
      if (msg.type === "setLimits") {
        void this.saveLimits(0, 0, msg.monthly ?? 0);
      }
      if (msg.type === "summarize") {
        this.onSummarize();
      }
      if (msg.type === "toggle") {
        this.expanded = !this.expanded;
        this.render();
      }
    });
    void this.refreshMonth().then(() => this.render());
  }

  setActivity(label: string | null): void {
    this.activity = label || "";
    this.render();
  }

  collapse(): void {
    this.expanded = false;
    this.render();
  }

  async publish(): Promise<void> {
    await this.refreshMonth();
  }

  setMonthlyLimit(monthly: number): Promise<void> {
    return this.saveLimits(0, 0, monthly);
  }

  async reveal(): Promise<void> {
    await this.refreshMonth();
  }

  update(event: TurnEvent): void {
    this.statsChatId = this.activeChatId();
    if (event.type === "context") {
      this.stats = {
        ...this.stats,
        percent: event.percent ?? this.stats.percent,
        used: event.used ?? this.stats.used,
        budget: event.budget ?? this.stats.budget,
        saved: event.saved ?? this.stats.saved,
        saved_truncation: event.saved_truncation ?? this.stats.saved_truncation,
        saved_history: event.saved_history ?? this.stats.saved_history,
        elided: event.elided ?? this.stats.elided,
        rules_tokens: event.rules_tokens ?? this.stats.rules_tokens,
        tools_tokens: event.tools_tokens ?? this.stats.tools_tokens,
        user_tokens: event.user_tokens ?? this.stats.user_tokens,
        historyFull: event.history_full ?? this.stats.historyFull,
        historySent: event.history_sent ?? this.stats.historySent,
      };
    } else if (event.type === "usage") {
      this.stats = {
        ...this.stats,
        prompt_tokens: event.prompt_tokens ?? this.stats.prompt_tokens,
        completion_tokens: event.completion_tokens ?? this.stats.completion_tokens,
        total_tokens: event.total_tokens ?? this.stats.total_tokens,
        cached_tokens: event.cached_tokens ?? this.stats.cached_tokens,
        saved: event.saved ?? this.stats.saved,
        used: event.used ?? this.stats.used,
        budget: event.budget ?? this.stats.budget,
        costUsd: event.costUsd ?? this.stats.costUsd,
        model: event.model ?? this.stats.model,
        taskType: event.taskType ?? this.stats.taskType,
        month: event.month ?? this.stats.month,
        rules_tokens: event.rules_tokens ?? this.stats.rules_tokens,
        tools_tokens: event.tools_tokens ?? this.stats.tools_tokens,
        user_tokens: event.user_tokens ?? this.stats.user_tokens,
        historyFull: event.history_full ?? this.stats.historyFull,
        historySent: event.history_sent ?? this.stats.historySent,
        recentCosts:
          event.costUsd != null
            ? [...this.stats.recentCosts, event.costUsd].slice(-5)
            : this.stats.recentCosts,
      };
      void this.refreshSpend(true);
      return;
    } else {
      return;
    }
    this.render();
  }

  async openSavingsReport(): Promise<void> {
    const chatId = this.activeChatId();
    const [session, month] = await Promise.all([
      chatId ? this.usage.chatRecords(chatId) : Promise.resolve([]),
      this.usage.monthRecords(),
    ]);
    const md = buildSavingsMarkdown(session.length ? session : month, month, loadSettings());
    const doc = await vscode.workspace.openTextDocument({ content: md, language: "markdown" });
    await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.One });
  }

  private async saveLimits(daily: number, weekly: number, monthly: number): Promise<void> {
    await saveSpendLimits(Math.max(0, daily), Math.max(0, weekly), Math.max(0, monthly));
    await this.refreshSpend(false);
    this.render();
  }

  private async refreshSpend(notify: boolean): Promise<void> {
    try {
      const settings = loadSettings();
      const chatId = this.activeChatId();
      const [month, recentCosts, periods, sessionRecords] = await Promise.all([
        this.usage.monthSummary(),
        this.usage.recentCosts(5),
        this.usage.periodSpend(settings),
        chatId ? this.usage.chatRecords(chatId) : Promise.resolve([]),
      ]);
      if (this.activeChatId() !== chatId) {
        return;
      }
      const session = sessionSavings(sessionRecords, settings);
      const switching = this.statsChatId !== chatId;
      this.stats = {
        ...this.stats,
        ...(switching ? turnFromRecords(sessionRecords, this.stats.budget) : {}),
        month,
        recentCosts,
        periods,
        sessionSavedTokens: session.savedTokens,
        sessionSavedUsd: session.savedUsd,
        sessionCacheUsd: session.cacheUsd,
        sessionSummaries: session.summaries,
      };
      if (switching) {
        this.statsChatId = chatId;
      }
      if (notify) {
        const alerts = (await this.usage.checkAndWarn(settings)).filter((a) => a.kind === "month");
        for (const alert of alerts) {
          void vscode.window.showWarningMessage(
            `CodeCook: Monthly spend at ${Math.round(alert.pct)}% of ${money(alert.limit)} (estimated).`
          );
        }
      }
      this.render();
    } catch {
      // Storage may not be ready before a folder is open.
    }
  }

  private async refreshMonth(): Promise<void> {
    await this.refreshSpend(false);
  }

  private headerMeta(stats: TokenStats): string {
    if (this.activity) {
      return escapeHtml(this.activity);
    }
    const pct = Math.max(0, Math.min(100, Math.round(stats.percent || 0)));
    return `${pct}% context · ${money(stats.month.costUsd)} this month`;
  }

  private snapshot(): TokenSnapshot {
    const stats = this.stats;
    const settings = loadSettings();
    const rateModel = stats.model || PRO_MODEL;
    const pair = compressionPair(compressionInput(stats), settings.turnTokenCeiling);
    const withTokens = pair.with;
    const savedTokens = pair.saved;
    const withoutTokens = pair.without;
    const savedPercent = withoutTokens > 0 ? Math.round((savedTokens / withoutTokens) * 100) : 0;
    const compressionUsd = Math.max(0, estimateCostUsd(settings, rateModel, savedTokens, 0));
    const prompt = Math.max(0, stats.prompt_tokens || 0);
    const cached = Math.max(0, stats.cached_tokens || 0);
    const cacheVisible = prompt > 0;
    const cachePercent = cacheVisible ? Math.round((Math.min(cached, prompt) / prompt) * 100) : 0;
    const fullCost = estimateCostUsd(settings, rateModel, prompt, stats.completion_tokens || 0);
    const displayCost = estimateDisplayCostUsd(settings, rateModel, prompt, stats.completion_tokens || 0, cached);
    const fullLabel = formatUsd(fullCost);
    const displayLabel = formatUsd(displayCost);
    const monthRow = (stats.periods.find((p) => p.kind === "month") ??
      periodSnapshots([], settings).find((p) => p.kind === "month"))!;
    const spent = formatUsd(stats.month.costUsd);
    const monthClass = monthRow.limit > 0 && monthRow.pct >= 100 ? "over" : monthRow.limit > 0 && monthRow.pct >= 80 ? "warn" : "";
    const ceiling = Math.max(0, settings.turnTokenCeiling || 0);
    const contextPercent = Math.max(0, Math.min(100, Math.round(stats.percent || 0)));
    return {
      contextPercent,
      savedPercent: Math.max(0, Math.min(100, savedPercent)),
      cachePercent: Math.max(0, Math.min(100, cachePercent)),
      cacheVisible,
      activity: this.activity,
      model: stats.model ? `${shortModel(stats.model)} · ${stats.taskType || "—"}` : "—",
      savedLegend: fmt(savedTokens),
      cacheLegend: cacheVisible ? `${cachePercent}%` : "—",
      savedTurn: `~${formatUsd(compressionUsd)}`,
      withoutTokens: `${fmt(withoutTokens)} tokens`,
      withTokens: `${fmt(withTokens)} tokens`,
      withoutPct: withoutTokens > 0 ? 100 : 0,
      withPct: withoutTokens > 0 ? Math.max(0, Math.min(100, (withTokens / withoutTokens) * 100)) : 0,
      costTurn: displayLabel,
      sessionTokens: compactTokens(stats.sessionSavedTokens),
      sessionUsd: `~${formatUsd(Math.max(0, stats.sessionSavedUsd))}`,
      contextLabel: `${compactTokens(withTokens)} / ${compactTokens(ceiling)}`,
      contextPct: ceiling > 0 ? Math.max(0, Math.min(100, (withTokens / ceiling) * 100)) : 0,
      month: monthRow.limit > 0 ? `${spent} of ${formatUsd(monthRow.limit)}` : `${spent} · No cap`,
      monthClass,
      monthPct: monthRow.limit > 0 ? Math.max(0, Math.min(100, monthRow.pct)) : 0,
      projected: `about ${formatUsd(monthRow.forecast)}`,
      user: fmt(stats.user_tokens),
      prompt: fmt(prompt),
      output: fmt(stats.completion_tokens),
      cached: cacheVisible ? `${fmt(Math.min(cached, prompt))} / ${fmt(prompt)}` : "—",
      withoutCache: fullLabel === displayLabel ? "" : fullLabel,
      sessionCache: `~${formatUsd(Math.max(0, stats.sessionCacheUsd))}`,
      summaries: fmt(stats.sessionSummaries),
      limit: settings.spendLimitMonthlyUsd || 0,
    };
  }

  private render(): void {
    this.onSnapshot?.(this.snapshot());
    if (!this.view) {
      return;
    }
    this.view.webview.html = this.html(this.stats);
  }

  private html(stats: TokenStats): string {
    const nonce = `${Date.now()}`;
    const month = stats.month;
    const model = shortModel(stats.model);
    const settings = loadSettings();
    const pair = compressionPair(compressionInput(stats), settings.turnTokenCeiling);
    const savedPct = pair.without > 0 ? Math.round((pair.saved / pair.without) * 100) : 0;
    const rateModel = stats.model || PRO_MODEL;
    const savedUsd = estimateCostUsd(settings, rateModel, pair.saved, 0);
    const spark = sparkline(stats.recentCosts);
    const monthRow = (stats.periods.find((p) => p.kind === "month") ??
      periodSnapshots([], settings).find((p) => p.kind === "month"))!;
    const monthValue =
      monthRow.left == null
        ? `Spent ${money(month.costUsd)} · No cap · Projected ~${money(monthRow.forecast)}`
        : `Spent ${money(month.costUsd)} · Left ${money(monthRow.left)} · Projected ~${money(monthRow.forecast)}`;
    const monthCls = monthRow.limit > 0 && monthRow.pct >= 100 ? " over" : monthRow.limit > 0 && monthRow.pct >= 80 ? " warn" : "";
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    body {
      margin: 0;
      padding: 14px 14px 16px;
      font-family: var(--vscode-font-family);
      background: var(--vscode-sideBar-background);
      color: var(--vscode-foreground);
    }
    .activity {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 0 0 12px;
      padding: 8px 0;
      border-bottom: 1px solid var(--vscode-panel-border);
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    .activity.hidden { display: none; }
    .spinner {
      width: 12px;
      height: 12px;
      border: 2px solid var(--vscode-panel-border);
      border-top-color: currentColor;
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .note { color: var(--vscode-descriptionForeground); font-size: 11px; margin: 0 0 10px; }
    .rows { margin: 0; }
    .row {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 12px;
      padding: 10px 0;
      border-bottom: 1px solid var(--vscode-panel-border);
      font-size: 13px;
    }
    .row span { color: var(--vscode-descriptionForeground); }
    .row b { font-weight: 550; color: var(--vscode-foreground); text-align: right; }
    .row.primary { padding: 12px 0; }
    .row.primary span { color: var(--vscode-foreground); font-weight: 600; }
    .row.primary b { font-weight: 650; font-size: 14px; display: flex; flex-direction: column; align-items: flex-end; gap: 3px; }
    .row.sep { border-top: 1px solid var(--vscode-panel-border); }
    .row.sub { padding: 7px 0; font-size: 12px; }
    .row.sub b { color: var(--vscode-foreground); font-weight: 500; }
    .hint { color: var(--vscode-descriptionForeground); font-weight: 500; font-size: 11px; }
    .warn b { color: var(--vscode-editorWarning-foreground); font-weight: 650; }
    .over b { color: var(--vscode-errorForeground); font-weight: 650; }
    .limits { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--vscode-panel-border); }
    .limits h3 { margin: 0 0 8px; font-size: 11px; font-weight: 600; color: var(--vscode-descriptionForeground); letter-spacing: .04em; text-transform: uppercase; }
    .limits label { display: flex; flex-direction: column; gap: 4px; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .limits input {
      width: 100%;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 6px;
      padding: 5px 6px;
      font: inherit;
    }
    .spark { display: block; margin: 2px 0 0 auto; color: var(--vscode-descriptionForeground); }
    .actions { display: flex; gap: 8px; margin-top: 14px; }
    button {
      flex: 1;
      background: var(--vscode-button-secondaryBackground, transparent);
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      padding: 7px 10px;
      font: inherit;
      font-size: 12px;
      cursor: pointer;
    }
    button:hover { border-color: var(--vscode-focusBorder); }
    button:disabled { opacity: 0.55; cursor: default; }
    .toggle {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      width: 100%;
      flex: none;
      margin: 0;
      padding: 8px 10px;
      background-color: var(--vscode-sideBar-background);
      color: var(--vscode-foreground);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      cursor: pointer;
      text-align: left;
    }
    .details:not(.hidden) { margin-top: 10px; }
    .toggle:hover {
      background-color: var(--vscode-sideBar-background);
      border-color: var(--vscode-foreground);
    }
    .toggle-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .toggle-title { font-size: 13px; font-weight: 600; }
    .toggle-meta { color: var(--vscode-descriptionForeground); font-size: 11px; }
    .chev { width: 14px; height: 14px; flex: 0 0 auto; transition: transform 0.15s ease; }
    .chev.open { transform: rotate(90deg); }
    .details.hidden { display: none; }
  </style>
</head>
<body>
  <button id="toggle" class="toggle" type="button" aria-expanded="${this.expanded ? "true" : "false"}">
    <span class="toggle-copy">
      <span class="toggle-title">Token optimizer</span>
      <span class="toggle-meta">${this.headerMeta(stats)}</span>
    </span>
    <svg class="chev${this.expanded ? " open" : ""}" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path></svg>
  </button>
  <div class="details${this.expanded ? "" : " hidden"}">
  <div id="activity" class="activity${this.activity ? "" : " hidden"}"><span class="spinner" aria-hidden="true"></span><span>${this.activity || ""}</span></div>
  <p class="note">Input and output are billed. Without compression is the full prompt, capped at the context window. With compression is the payload sent on the latest call. Saved is that difference, counted once.</p>
  <div class="rows">
    <div class="row primary"><span>Input</span><b>${fmt(stats.prompt_tokens)}</b></div>
    <div class="row primary"><span>Output</span><b>${fmt(stats.completion_tokens)} · ${money(stats.costUsd)}</b></div>
    <div class="row"><span>Your message (tokens)</span><b>${fmt(stats.user_tokens)}</b></div>
    <div class="row"><span>Without compression</span><b>${fmt(pair.without)}</b></div>
    <div class="row"><span>With compression</span><b>${fmt(pair.with)}</b></div>
    <div class="row primary"><span>Saved</span><b>${fmt(pair.saved)} <span class="hint">${pair.without ? `${savedPct}%` : ""} · ${money(savedUsd)}</span></b></div>
    <div class="row sub"><span>Cached</span><b>${fmt(stats.cached_tokens)}</b></div>
    <div class="row primary sep${monthCls}"><span>This month</span><b>${monthValue}${spark}</b></div>
    <div class="row sub"><span>Model / task</span><b>${model} · ${stats.taskType || "—"}</b></div>
  </div>
  <div class="limits">
    <h3>Monthly spend limit (USD)</h3>
    <label>Cap<input id="monthly" type="number" min="0" step="0.01" value="${settings.spendLimitMonthlyUsd || ""}" placeholder="0 = no cap"></label>
  </div>
  <div class="actions">
    <button id="summarize"${this.activity ? " disabled" : ""}>Summarize chat</button>
    <button id="report">Savings report</button>
  </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById("toggle").addEventListener("click", () => vscode.postMessage({ type: "toggle" }));
    const report = document.getElementById("report");
    const summarize = document.getElementById("summarize");
    const monthly = document.getElementById("monthly");
    if (report) report.addEventListener("click", () => vscode.postMessage({ type: "savingsReport" }));
    if (summarize) summarize.addEventListener("click", () => vscode.postMessage({ type: "summarize" }));
    if (monthly) monthly.addEventListener("change", () => vscode.postMessage({
      type: "setLimits",
      monthly: Number(monthly.value) || 0,
    }));
  </script>
</body>
</html>`;
  }
}

function compressionInput(stats: TokenStats): Pick<UsageRecord, "used" | "saved" | "historyFull" | "historySent"> {
  const hasHistory = stats.historyFull > 0 || stats.historySent > 0;
  return {
    used: stats.used,
    saved: stats.saved,
    historyFull: hasHistory ? stats.historyFull : undefined,
    historySent: hasHistory ? stats.historySent : undefined,
  };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fmt(n: number): string {
  return new Intl.NumberFormat("en-US").format(Math.max(0, Math.round(n || 0)));
}

function money(n: number): string {
  return formatUsd(n || 0);
}

function turnFromRecords(records: UsageRecord[], budget: number): Partial<TokenStats> {
  const latest = [...records].reverse().find((row) => row.kind !== "summary");
  if (!latest) {
    return {
      percent: 0,
      used: 0,
      saved: 0,
      saved_truncation: 0,
      saved_history: 0,
      elided: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      cached_tokens: 0,
      costUsd: 0,
      model: "",
      taskType: "",
      user_tokens: 0,
      rules_tokens: 0,
      tools_tokens: 0,
      historyFull: 0,
      historySent: 0,
    };
  }
  const used = Math.max(0, latest.used || 0);
  return {
    percent: budget > 0 ? Math.min(100, Math.round((used / budget) * 100)) : 0,
    used,
    saved: Math.max(0, latest.saved || 0),
    prompt_tokens: Math.max(0, latest.prompt || 0),
    completion_tokens: Math.max(0, latest.completion || 0),
    total_tokens: Math.max(0, (latest.prompt || 0) + (latest.completion || 0)),
    cached_tokens: Math.max(0, latest.cached || 0),
    costUsd: latest.costUsd || 0,
    model: latest.model || "",
    taskType: latest.taskType || "",
    user_tokens: 0,
    historyFull: latest.historyFull ?? 0,
    historySent: latest.historySent ?? 0,
  };
}

function compactTokens(n: number): string {
  const value = Math.max(0, Math.round(n || 0));
  if (value < 1000) {
    return fmt(value);
  }
  const scale = value < 1_000_000 ? 1000 : 1_000_000;
  const suffix = scale === 1000 ? "k" : "M";
  const scaled = value / scale;
  const shown = scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10;
  return `${Number.isInteger(shown) ? shown.toFixed(0) : shown.toFixed(1)}${suffix}`;
}

function sparkline(values: number[]): string {
  if (values.length < 2) {
    return "";
  }
  const w = 56;
  const h = 14;
  const max = Math.max(...values, 0.0001);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const pts = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * (w - 2) + 1;
      const y = h - 1 - ((v - min) / span) * (h - 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline fill="none" stroke="currentColor" stroke-width="1.2" points="${pts}"/></svg>`;
}

function shortModel(id: string): string {
  if (!id) {
    return "—";
  }
  if (id.includes("flash")) {
    return "Flash";
  }
  if (id.includes("pro")) {
    return "Pro";
  }
  return id.replace(/^gemini-/, "");
}
