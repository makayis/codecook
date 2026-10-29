import * as vscode from "vscode";

let channel: vscode.OutputChannel | undefined;

export function getLog(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel("CodeCook");
  }
  return channel;
}

export function log(message: string): void {
  getLog().appendLine(`[${new Date().toISOString()}] ${message}`);
}
