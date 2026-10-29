import * as vscode from "vscode";
import type { Plan, Todo } from "./types";

export class PlanPanel {
  private panel?: vscode.WebviewPanel;

  constructor(private readonly onBuild: () => void) {}

  clear(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }

  show(plan?: Partial<Plan>, todos?: Todo[]): void {
    if (!plan && !todos?.length) {
      return;
    }
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        "codecook.plan",
        plan?.title || "CodeCook Plan",
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      this.panel.onDidDispose(() => {
        this.panel = undefined;
      });
      this.panel.webview.onDidReceiveMessage((msg: { type?: string }) => {
        if (msg.type === "buildPlan") {
          this.onBuild();
        }
      });
    }
    this.panel.title = plan?.title || "CodeCook Plan";
    this.panel.webview.html = this.html(plan, todos || []);
    this.panel.reveal(vscode.ViewColumn.One, true);
  }

  private html(plan: Partial<Plan> | undefined, todos: Todo[]): string {
    const nonce = `${Date.now()}`;
    const title = escapeHtml(plan?.title || "Plan");
    const overview = escapeHtml(plan?.overview || "");
    const body = renderMarkdown(plan?.body_md || "");
    const draft = plan?.status === "draft";
    const todoHtml = todos
      .map((t) => {
        const cls = t.status === "completed" ? "done" : t.status === "in_progress" ? "progress" : "";
        return `<li class="${cls}"><span class="st">${escapeHtml(t.status)}</span>${escapeHtml(t.content)}</li>`;
      })
      .join("");
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    body { margin: 0; font-family: var(--vscode-font-family); background: var(--vscode-editor-background); color: var(--vscode-foreground); line-height: 1.55; }
    .wrap { max-width: 860px; margin: 0 auto; padding: 28px 32px 80px; }
    h1 { font-size: 22px; font-weight: 600; margin: 0 0 8px; }
    .overview { color: var(--vscode-descriptionForeground); margin: 0 0 24px; }
    h2, h3 { margin: 24px 0 8px; font-weight: 600; }
    p { margin: 8px 0; }
    pre { background: var(--vscode-textCodeBlock-background); border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 12px; overflow: auto; }
    code { font-family: var(--vscode-editor-font-family); font-size: 12px; }
    ul.todos { list-style: none; padding: 0; margin: 16px 0 0; }
    ul.todos li { padding: 8px 10px; border: 1px solid var(--vscode-panel-border); border-radius: 8px; margin: 0 0 8px; background: var(--vscode-input-background); }
    ul.todos li.done { opacity: .55; text-decoration: line-through; }
    ul.todos li.progress { border-color: var(--vscode-focusBorder); }
    .st { display: inline-block; min-width: 92px; color: var(--vscode-descriptionForeground); font-size: 11px; text-transform: uppercase; }
    .bar { position: sticky; top: 0; display: flex; justify-content: space-between; align-items: center; padding: 12px 32px; background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-panel-border); }
    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; border-radius: 8px; padding: 8px 14px; font: inherit; cursor: pointer; }
    button.hidden { display: none; }
  </style>
</head>
<body>
  <div class="bar">
    <div>Plan</div>
    <button id="build" class="${draft ? "" : "hidden"}">Build plan</button>
  </div>
  <div class="wrap">
    <h1>${title}</h1>
    <p class="overview">${overview}</p>
    <div class="body">${body}</div>
    <h2>Tasks</h2>
    <ul class="todos">${todoHtml || "<li>No tasks yet.</li>"}</ul>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById("build").addEventListener("click", () => vscode.postMessage({ type: "buildPlan" }));
  </script>
</body>
</html>`;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderMarkdown(src: string): string {
  const escaped = escapeHtml(src);
  const parts: string[] = [];
  let i = 0;
  const fence = /```(\w*)\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(escaped))) {
    parts.push(inline(escaped.slice(i, m.index)));
    parts.push(`<pre><code>${m[2]}</code></pre>`);
    i = m.index + m[0].length;
  }
  parts.push(inline(escaped.slice(i)));
  return parts.join("");
}

function inline(text: string): string {
  return text
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/^\- (.+)$/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>\n?)+/g, (block) => `<ul>${block}</ul>`)
    .replace(/\n{2,}/g, "</p><p>")
    .replace(/\n/g, "<br>");
}
