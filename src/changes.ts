import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { type Checkpoint, type CheckpointFile, restoreFiles } from "./checkpoints";
import { getWorkspaceFolder } from "./store";
import type { Plan, Todo } from "./types";

export interface FileChange {
  fsPath: string;
  rel: string;
  before: string;
  created: boolean;
}

export class ChangeTracker {
  private readonly map = new Map<string, FileChange>();
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private checkpointChatId?: string;
  private checkpointSeq?: number;

  constructor(private readonly checkpointRoot?: string) {}

  beginTurn(): void {
    this.map.clear();
    this.checkpointChatId = undefined;
    this.checkpointSeq = undefined;
    this.emitter.fire();
  }

  async beginCheckpoint(chatId: string, seq: number, plan?: Plan | null, todos?: Todo[] | null): Promise<void> {
    this.checkpointChatId = chatId;
    this.checkpointSeq = seq;
    const existing = await this.readCheckpoint(chatId, seq);
    if (existing) {
      return;
    }
    await this.writeCheckpoint(chatId, { seq, files: [], plan: plan ?? null, todos: todos ?? null });
  }

  async snapshotBefore(uri: vscode.Uri): Promise<void> {
    if (this.map.has(uri.fsPath)) {
      return;
    }
    const change = await this.capture(uri);
    this.map.set(uri.fsPath, change);
    await this.rememberCheckpoint(change);
    this.emitter.fire();
  }

  private async capture(uri: vscode.Uri): Promise<FileChange> {
    const folder = getWorkspaceFolder();
    const rel = folder ? vscode.workspace.asRelativePath(uri, false) : uri.fsPath;
    const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
    if (open) {
      return { fsPath: uri.fsPath, rel, before: open.getText(), created: false };
    }
    try {
      const raw = await vscode.workspace.fs.readFile(uri);
      return { fsPath: uri.fsPath, rel, before: Buffer.from(raw).toString("utf8"), created: false };
    } catch {
      return { fsPath: uri.fsPath, rel, before: "", created: true };
    }
  }

  list(): FileChange[] {
    return [...this.map.values()].sort((a, b) => a.rel.localeCompare(b.rel));
  }

  getBefore(fsPath: string): string | undefined {
    return this.map.get(fsPath)?.before;
  }

  get(fsPath: string): FileChange | undefined {
    return this.map.get(fsPath);
  }

  keepAll(): void {
    this.map.clear();
    this.emitter.fire();
  }

  async revertAll(): Promise<number> {
    const items = this.list();
    for (const change of items) {
      await this.applyChange(change);
    }
    this.map.clear();
    this.emitter.fire();
    return items.length;
  }

  async restoreCheckpoint(chatId: string, seq: number): Promise<{
    count: number;
    found: boolean;
    plan?: Plan | null;
    todos?: Todo[] | null;
  }> {
    const checkpoints = await this.listCheckpoints(chatId);
    const target = checkpoints.find((checkpoint) => checkpoint.seq === seq);
    const files = restoreFiles(checkpoints, seq);
    for (const file of files) {
      await this.applyChange(file);
    }
    for (const checkpoint of checkpoints) {
      if (checkpoint.seq >= seq) {
        await this.deleteCheckpoint(chatId, checkpoint.seq);
      }
    }
    if (this.checkpointChatId === chatId && this.checkpointSeq != null && this.checkpointSeq >= seq) {
      this.checkpointChatId = undefined;
      this.checkpointSeq = undefined;
    }
    this.map.clear();
    this.emitter.fire();
    return {
      count: files.length,
      found: Boolean(target),
      plan: target?.plan,
      todos: target?.todos,
    };
  }

  private async applyChange(change: FileChange | CheckpointFile): Promise<void> {
    const uri = vscode.Uri.file(change.fsPath);
    if (change.created) {
      try {
        await vscode.workspace.fs.delete(uri, { useTrash: false });
      } catch {
        // File may already be gone.
      }
      return;
    }
    const bytes = Buffer.from(change.before, "utf8");
    await this.matchOpenDocument(uri, change.before);
    await vscode.workspace.fs.writeFile(uri, bytes);
    await this.matchOpenDocument(uri, change.before);
    const open = vscode.workspace.textDocuments.find((document) => document.uri.fsPath === uri.fsPath);
    if (open?.isDirty && open.getText() === change.before) {
      try {
        await open.save();
      } catch {
        // The disk write above is what the browser reads.
      }
    }
    await vscode.workspace.fs.writeFile(uri, bytes);
  }

  private async matchOpenDocument(uri: vscode.Uri, text: string): Promise<void> {
    const doc = vscode.workspace.textDocuments.find((document) => document.uri.fsPath === uri.fsPath);
    if (!doc || doc.getText() === text) {
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    const range = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
    edit.replace(doc.uri, range, text);
    await vscode.workspace.applyEdit(edit);
  }

  private async rememberCheckpoint(change: FileChange): Promise<void> {
    if (!this.checkpointChatId || this.checkpointSeq == null) {
      return;
    }
    const checkpoint = (await this.readCheckpoint(this.checkpointChatId, this.checkpointSeq)) ?? {
      seq: this.checkpointSeq,
      files: [],
      plan: null,
      todos: null,
    };
    if (checkpoint.files.some((file) => file.fsPath === change.fsPath)) {
      return;
    }
    checkpoint.files.push(change);
    await this.writeCheckpoint(this.checkpointChatId, checkpoint);
  }

  private chatDir(chatId: string): string | undefined {
    if (!this.checkpointRoot) {
      return undefined;
    }
    const safe = chatId.replace(/[^A-Za-z0-9_-]+/g, "_") || "chat";
    return path.join(this.checkpointRoot, safe);
  }

  private async readCheckpoint(chatId: string, seq: number): Promise<Checkpoint | undefined> {
    const dir = this.chatDir(chatId);
    if (!dir) {
      return undefined;
    }
    const file = path.join(dir, `${seq}.json`);
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as Checkpoint;
    } catch {
      return undefined;
    }
  }

  private async writeCheckpoint(chatId: string, checkpoint: Checkpoint): Promise<void> {
    const dir = this.chatDir(chatId);
    if (!dir) {
      return;
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${checkpoint.seq}.json`), JSON.stringify(checkpoint));
  }

  private async listCheckpoints(chatId: string): Promise<Checkpoint[]> {
    const dir = this.chatDir(chatId);
    if (!dir || !fs.existsSync(dir)) {
      return [];
    }
    const checkpoints: Checkpoint[] = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".json")) {
        continue;
      }
      try {
        checkpoints.push(JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as Checkpoint);
      } catch {
        // Skip a damaged checkpoint file.
      }
    }
    return checkpoints.sort((a, b) => a.seq - b.seq);
  }

  private async deleteCheckpoint(chatId: string, seq: number): Promise<void> {
    const dir = this.chatDir(chatId);
    if (!dir) {
      return;
    }
    try {
      fs.unlinkSync(path.join(dir, `${seq}.json`));
    } catch {
      // Already removed.
    }
  }
}

export const BEFORE_SCHEME = "makayis-before";

export class BeforeSnapshotProvider implements vscode.TextDocumentContentProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly tracker: ChangeTracker) {
    tracker.onDidChange(() => {
      for (const change of tracker.list()) {
        this.emitter.fire(beforeUri(change.fsPath));
      }
    });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.tracker.getBefore(uri.query) ?? "";
  }
}

export function beforeUri(fsPath: string): vscode.Uri {
  const unique = "/" + fsPath.replace(/\\/g, "/").replace(/:/g, "");
  return vscode.Uri.from({ scheme: BEFORE_SCHEME, path: unique, query: fsPath });
}
