import * as path from "path";
import * as vscode from "vscode";
import type { Mention } from "./types";

interface CachedSelection {
  uri: vscode.Uri;
  range: vscode.Range;
}

let cached: CachedSelection | undefined;

export function rememberEditorSelection(editor: vscode.TextEditor | undefined): void {
  if (!editor || editor.selection.isEmpty) {
    return;
  }
  const scheme = editor.document.uri.scheme;
  if (scheme !== "file" && scheme !== "untitled") {
    return;
  }
  cached = { uri: editor.document.uri, range: editor.selection };
}

export function isPassedMention(value: unknown): value is Mention {
  if (!value || typeof value !== "object") {
    return false;
  }
  const mention = value as Mention;
  return (
    (mention.kind === "file" || mention.kind === "selection" || mention.kind === "terminal") &&
    typeof mention.label === "string" &&
    mention.label.length > 0
  );
}

export function selectionMentionFrom(editor: vscode.TextEditor | undefined): Mention | undefined {
  if (editor && !editor.selection.isEmpty) {
    return mentionFor(editor.document, editor.selection);
  }
  if (!cached) {
    return undefined;
  }
  const document = vscode.workspace.textDocuments.find((item) => item.uri.toString() === cached?.uri.toString());
  if (!document) {
    return undefined;
  }
  return mentionFor(document, cached.range);
}

function mentionFor(document: vscode.TextDocument, range: vscode.Range): Mention | undefined {
  let text = "";
  try {
    text = document.getText(range);
  } catch {
    return undefined;
  }
  if (!text.trim()) {
    return undefined;
  }
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  const rel = folder ? path.relative(folder.uri.fsPath, document.uri.fsPath) : "";
  const mentionPath = rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.replace(/\\/g, "/") : undefined;
  const start = range.start.line + 1;
  const end = range.end.line + 1;
  const base = path.basename(mentionPath || document.fileName || "selection");
  const label = start === end ? `${base}:${start}` : `${base}:${start}-${end}`;
  return { kind: "selection", label, path: mentionPath, text };
}

export function registerSelectionCodeLens(): vscode.Disposable {
  const emitter = new vscode.EventEmitter<void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const provider: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: emitter.event,
    provideCodeLenses(document) {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.toString() !== document.uri.toString() || editor.selection.isEmpty) {
        return [];
      }
      const mention = mentionFor(editor.document, editor.selection);
      if (!mention) {
        return [];
      }
      const line = editor.selection.start.line;
      return [
        new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
          title: "$(comment-discussion) Add to Chat",
          command: "codecook.addSelectionToChat",
          arguments: [mention],
        }),
      ];
    },
  };
  const refresh = () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => emitter.fire(), 80);
  };
  return vscode.Disposable.from(
    vscode.languages.registerCodeLensProvider([{ scheme: "file" }, { scheme: "untitled" }], provider),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      rememberEditorSelection(event.textEditor);
      refresh();
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      rememberEditorSelection(editor);
      refresh();
    }),
    emitter,
    new vscode.Disposable(() => {
      if (timer) {
        clearTimeout(timer);
      }
    })
  );
}
