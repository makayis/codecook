import * as path from "path";
import * as vscode from "vscode";
import { BEFORE_SCHEME, BeforeSnapshotProvider, ChangeTracker } from "./changes";
import { openAllDiffs, openDiff } from "./changeReview";
import { MakayisChatView } from "./chatView";
import { isPassedMention, registerSelectionCodeLens, selectionMentionFrom } from "./selectionChat";
import { getLog } from "./log";
import { PlanPanel } from "./planPanel";
import { ChatStore } from "./store";
import { TokenPanel } from "./tokenPanel";
import { UsageStore } from "./usageStore";
import { pingUsage } from "./usagePing";

export function activate(context: vscode.ExtensionContext): void {
  void vscode.commands.executeCommand("setContext", "codecook.signedIn", false);
  const store = new ChatStore(context);
  const usage = new UsageStore(context);
  const storage = context.storageUri ?? context.globalStorageUri;
  const tracker = new ChangeTracker(storage ? path.join(storage.fsPath, "checkpoints") : undefined);
  let provider!: MakayisChatView;
  const planPanel = new PlanPanel(() => provider.buildPlan());
  const tokenPanel = new TokenPanel(usage, () => provider.activeChatId(), () => {
    void provider.summarizeActive();
  }, (snapshot) => provider.showTokenStats(snapshot));
  provider = new MakayisChatView(context, store, planPanel, tracker, tokenPanel, usage, () => {
    provider.postChanges();
  });
  provider.syncAuthContext();

  context.subscriptions.push(getLog());
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(MakayisChatView.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("codecook.openTokens", () => provider.openTokenSection()),
    vscode.commands.registerCommand("codecook.savingsReport", () => tokenPanel.openSavingsReport()),
    vscode.commands.registerCommand("codecook.summarizeChat", () => provider.summarizeActive()),
    vscode.workspace.registerTextDocumentContentProvider(BEFORE_SCHEME, new BeforeSnapshotProvider(tracker)),
    vscode.commands.registerCommand("codecook.openChat", async () => {
      try {
        await vscode.commands.executeCommand("workbench.view.extension.codecookSidebar");
      } catch {
        await vscode.commands.executeCommand("codecook.chat.focus");
      }
    }),
    vscode.commands.registerCommand("codecook.newChat", () => provider.newChat()),
    vscode.commands.registerCommand("codecook.cancel", () => provider.cancel()),
    vscode.commands.registerCommand("codecook.buildPlan", () => provider.buildPlan()),
    vscode.commands.registerCommand("codecook.openPlan", () => provider.openPlan()),
    vscode.commands.registerCommand("codecook.showChanges", () => provider.openChangesSection()),
    vscode.commands.registerCommand("codecook.openDiff", (fsPath?: string) => {
      if (typeof fsPath === "string") {
        return openDiff(fsPath, tracker);
      }
    }),
    vscode.commands.registerCommand("codecook.openAllDiffs", () => openAllDiffs(tracker)),
    vscode.commands.registerCommand("codecook.keepAll", () => {
      const count = tracker.list().length;
      tracker.keepAll();
      void vscode.window.showInformationMessage(
        count ? `CodeCook: kept ${count} file${count === 1 ? "" : "s"}.` : "CodeCook: no changes to keep."
      );
    }),
    vscode.commands.registerCommand("codecook.revertAll", async () => {
      const count = await tracker.revertAll();
      void vscode.window.showInformationMessage(
        count ? `CodeCook: reverted ${count} file${count === 1 ? "" : "s"}.` : "CodeCook: no changes to revert."
      );
    }),
    registerSelectionCodeLens(),
    vscode.commands.registerCommand("codecook.addSelectionToChat", async (passed?: unknown) => {
      const mention = isPassedMention(passed) && passed.kind === "selection" && passed.text?.trim()
        ? passed
        : selectionMentionFrom(vscode.window.activeTextEditor);
      if (!mention?.text?.trim()) {
        void vscode.window.showInformationMessage("Highlight code, then choose Add to Chat.");
        return;
      }
      await provider.addToChat(mention);
    }),
    vscode.commands.registerCommand("codecook.addTerminalToChat", async () => {
      const terminal = vscode.window.activeTerminal as (vscode.Terminal & { selection?: string }) | undefined;
      let text = terminal?.selection?.trim() ?? "";
      if (!text) {
        try {
          await vscode.commands.executeCommand("workbench.action.terminal.copySelection");
          text = (await vscode.env.clipboard.readText()).trim();
        } catch {
          text = "";
        }
      }
      if (!text) {
        void vscode.window.showInformationMessage("Highlight terminal text, then choose Add to Chat.");
        return;
      }
      await provider.addToChat({ kind: "terminal", label: "Terminal", text });
    }),
    vscode.commands.registerCommand("codecook.addFileToChat", async (clicked?: unknown, selected?: unknown) => {
      const picked = Array.isArray(selected) ? selected.filter((item): item is vscode.Uri => item instanceof vscode.Uri) : [];
      const uris = picked.length
        ? picked
        : clicked instanceof vscode.Uri
          ? [clicked]
          : vscode.window.activeTextEditor
            ? [vscode.window.activeTextEditor.document.uri]
            : [];
      if (!uris.length) {
        void vscode.window.showInformationMessage("Right-click a file in the Explorer, then choose Add to CodeCook Chat.");
        return;
      }
      await provider.addFilesToChat(uris);
    })
  );
  pingUsage(context);
}

export function deactivate(): void {}
