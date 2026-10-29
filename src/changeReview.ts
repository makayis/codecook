import * as vscode from "vscode";
import { beforeUri, ChangeTracker, type FileChange } from "./changes";

export class ChangeTreeProvider implements vscode.TreeDataProvider<FileChange> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly tracker: ChangeTracker) {
    tracker.onDidChange(() => this.emitter.fire());
  }

  getTreeItem(change: FileChange): vscode.TreeItem {
    const item = new vscode.TreeItem(change.rel, vscode.TreeItemCollapsibleState.None);
    item.description = change.created ? "added" : "modified";
    item.contextValue = "makayisChange";
    item.command = {
      command: "codecook.openDiff",
      title: "Open Diff",
      arguments: [change.fsPath],
    };
    item.iconPath = new vscode.ThemeIcon(change.created ? "diff-added" : "diff-modified");
    return item;
  }

  getChildren(): FileChange[] {
    return this.tracker.list();
  }
}

export async function openDiff(fsPath: string, tracker: ChangeTracker): Promise<void> {
  const change = tracker.get(fsPath);
  if (!change) {
    return;
  }
  const current = vscode.Uri.file(fsPath);
  const title = `${change.rel} (CodeCook)`;
  await vscode.commands.executeCommand("vscode.diff", beforeUri(fsPath), current, title);
}

export async function openAllDiffs(tracker: ChangeTracker): Promise<void> {
  const items = tracker.list();
  for (const change of items) {
    await openDiff(change.fsPath, tracker);
  }
  if (!items.length) {
    void vscode.window.showInformationMessage("CodeCook: no file changes in this turn.");
  }
}
