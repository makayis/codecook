import * as crypto from "crypto";
import * as vscode from "vscode";
import type { MonthUsage, PeriodKind, PeriodSpend, Settings, UsageRecord } from "./types";
import { monthKey, periodBounds, periodSnapshots, summarizeMonth, warnLevel } from "./usageStats";

const RETAIN = 100 * 24 * 60 * 60 * 1000;

interface WarnSlot {
  key: string;
  level: number;
}

interface UsageFile {
  records: UsageRecord[];
  warns?: Partial<Record<PeriodKind, WarnSlot>>;
}

export interface SpendAlert {
  kind: PeriodKind;
  pct: number;
  limit: number;
  used: number;
}

function workspaceKey(folder: vscode.Uri): string {
  return crypto.createHash("sha1").update(folder.fsPath).digest("hex").slice(0, 16);
}

export class UsageStore {
  private queue: Promise<unknown> = Promise.resolve();
  private cache: UsageFile | null = null;
  private fileUri: vscode.Uri | null = null;

  constructor(private context: vscode.ExtensionContext) {}

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  private async resolveFile(): Promise<vscode.Uri> {
    if (this.fileUri) {
      return this.fileUri;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    const root = this.context.storageUri ?? this.context.globalStorageUri;
    if (!root) {
      throw new Error("Extension storage is not available.");
    }
    await vscode.workspace.fs.createDirectory(root);
    const key = folder ? workspaceKey(folder.uri) : "global";
    this.fileUri = vscode.Uri.joinPath(root, `usage-${key}.json`);
    return this.fileUri;
  }

  private async ensureLoaded(): Promise<UsageFile> {
    if (this.cache) {
      return this.cache;
    }
    const file = await this.resolveFile();
    try {
      const raw = await vscode.workspace.fs.readFile(file);
      this.cache = JSON.parse(Buffer.from(raw).toString("utf8")) as UsageFile;
      if (!Array.isArray(this.cache.records)) {
        this.cache = { records: [], warns: {} };
      }
      this.cache.warns = this.cache.warns ?? {};
    } catch {
      this.cache = { records: [], warns: {} };
    }
    return this.cache;
  }

  private async persist(): Promise<void> {
    if (!this.cache) {
      return;
    }
    const file = await this.resolveFile();
    await vscode.workspace.fs.writeFile(file, Buffer.from(JSON.stringify(this.cache, null, 2), "utf8"));
  }

  async record(row: UsageRecord): Promise<MonthUsage> {
    return this.run(async () => {
      const data = await this.ensureLoaded();
      const cutoff = Date.now() - RETAIN;
      data.records = data.records.filter((r) => r.ts >= cutoff);
      data.records.push(row);
      await this.persist();
      return summarizeMonth(data.records);
    });
  }

  async monthSummary(key = monthKey()): Promise<MonthUsage> {
    return this.run(async () => {
      const data = await this.ensureLoaded();
      return summarizeMonth(data.records, key);
    });
  }

  async monthRecords(key = monthKey()): Promise<UsageRecord[]> {
    return this.run(async () => {
      const data = await this.ensureLoaded();
      return data.records.filter((r) => monthKey(r.ts) === key);
    });
  }

  async recentCosts(limit = 5): Promise<number[]> {
    return this.run(async () => {
      const data = await this.ensureLoaded();
      return data.records.slice(-limit).map((r) => r.costUsd || 0);
    });
  }

  async periodSpend(settings: Settings, now = Date.now()): Promise<PeriodSpend[]> {
    return this.run(async () => {
      const data = await this.ensureLoaded();
      return periodSnapshots(data.records, settings, now);
    });
  }

  async checkAndWarn(settings: Settings, now = Date.now()): Promise<SpendAlert[]> {
    return this.run(async () => {
      const data = await this.ensureLoaded();
      const snaps = periodSnapshots(data.records, settings, now);
      const alerts: SpendAlert[] = [];
      data.warns = data.warns ?? {};
      for (const snap of snaps) {
        if (snap.limit <= 0) {
          continue;
        }
        const { key } = periodBounds(snap.kind, now);
        const prev = data.warns[snap.kind];
        const lastLevel = prev?.key === key ? prev.level : 0;
        const next = warnLevel(snap.pct);
        if (next > lastLevel) {
          data.warns[snap.kind] = { key, level: next };
          alerts.push({ kind: snap.kind, pct: snap.pct, limit: snap.limit, used: snap.used });
        }
      }
      if (alerts.length) {
        await this.persist();
      }
      return alerts;
    });
  }

  async chatRecords(chatId: string): Promise<UsageRecord[]> {
    return this.run(async () => {
      const data = await this.ensureLoaded();
      return data.records.filter((r) => r.chatId === chatId);
    });
  }
}

export { emptyMonth, monthKey, summarizeMonth, summarizeRecords } from "./usageStats";
