import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { AccountService } from "./accountService";
import { attachmentPrompt, attachmentKind, decodeAttachment, saveChatAttachment, setAttachmentRoot } from "./attachments";
import { loadSettings } from "./config";
import type { ChangeTracker } from "./changes";
import { createLlmClient } from "./llmClient";
import { AgentLoop } from "./loop";
import { PROBE_OUTPUT_TOKENS, probeModelIds } from "./modelProbe";
import type { PlanPanel } from "./planPanel";
import { ChatStore, getWorkspaceFolder } from "./store";
import { buildMentionBlocks, isBinaryMention } from "./mentions";
import { resolveWorkspacePath } from "./path";
import { middleTruncate } from "./text";
import type { TokenPanel, TokenSnapshot } from "./tokenPanel";
import type { UsageStore } from "./usageStore";
import type { Attachment, Mention, Mode, TurnEvent } from "./types";

export class MakayisChatView implements vscode.WebviewViewProvider {
  public static readonly viewId = "codecook.chat";
  private view?: vscode.WebviewView;
  private abort?: AbortController;
  private runningChatId?: string;
  private lastChatId?: string;
  private turnError?: string;
  private queuedMentions: Mention[] = [];
  private readonly accounts: AccountService;
  private probeAbort?: AbortController;
  private probeGen = 0;
  private probeView: {
    running: boolean;
    done: number;
    total: number;
    failed: number;
    models: Array<{ id: string; label: string }>;
    error?: string;
  } = { running: false, done: 0, total: 0, failed: 0, models: [] };

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: ChatStore,
    private readonly planPanel: PlanPanel,
    private readonly tracker: ChangeTracker,
    private readonly tokenPanel: TokenPanel,
    private readonly usage: UsageStore,
    private readonly onChangesReady: () => void
  ) {
    this.accounts = new AccountService(context);
    const storage = context.storageUri ?? context.globalStorageUri;
    if (storage) {
      setAttachmentRoot(path.join(storage.fsPath, "temp"));
    }
    this.tracker.onDidChange(() => this.postChanges());
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.onDidDispose(() => {
      if (this.view === webviewView) {
        this.view = undefined;
      }
    });
    try {
      webviewView.webview.html = this.html();
      webviewView.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      webviewView.webview.html = `<html><body style="color:var(--vscode-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family);padding:16px">CodeCook failed to load: ${message}</body></html>`;
    }
  }

  async newChat(): Promise<void> {
    if (!getWorkspaceFolder()) {
      this.post({ type: "error", error: "Open a folder before using CodeCook." });
      return;
    }
    const chat = await this.store.createChat("agent");
    await this.pushState(chat.id);
    void this.tokenPanel.publish();
  }

  async cancel(): Promise<void> {
    if (!this.abort) {
      return;
    }
    this.abort.abort();
    this.post({ type: "error", error: "Cancelled" });
  }

  async summarizeActive(): Promise<void> {
    if (this.abort) {
      this.post({ type: "error", error: "Cannot summarize while a turn is running." });
      return;
    }
    const chat = await this.store.getActiveChat();
    if (!chat) {
      this.post({ type: "error", error: "No chat to summarize." });
      return;
    }
    if (!chat.messages.length) {
      this.post({ type: "status", message: "Nothing to summarize yet." });
      return;
    }
    const credential = await this.requireCredential();
    if (!credential) {
      return;
    }
    this.abort = new AbortController();
    this.tokenPanel.setActivity("Summarizing");
    const settings = loadSettings();
    const loop = new AgentLoop(this.store, settings, (event) => this.onTurnEvent(event));
    loop.useCredential(credential);
    loop.useModelList(this.accounts.cachedModelIds());
    let result: string | undefined;
    try {
      const ok = await loop.compactHistory(chat, this.abort.signal);
      result = ok
        ? "Chat summarized. Future turns use the compact history."
        : "Summarize failed.";
    } catch (err) {
      this.post({ type: "error", error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.tokenPanel.setActivity(null);
      this.abort = undefined;
      this.post({ type: "turn_ended" });
      await this.pushState(chat.id);
      void this.tokenPanel.publish();
      if (result) {
        this.post({ type: "status", message: result });
      }
    }
  }

  async buildPlan(): Promise<void> {
    const chat = await this.store.getActiveChat();
    if (!chat?.plan) {
      this.post({ type: "error", error: "No plan to build." });
      return;
    }
    if (this.abort) {
      this.post({ type: "error", error: "Cannot update the plan while a turn is running." });
      return;
    }
    const approved = { ...chat.plan, status: "approved" as const };
    await this.store.savePlan(chat.id, approved);
    await this.store.updateChat(chat.id, { mode: "agent" });
    this.planPanel.show(approved, chat.todos);
    await this.startTurn(chat.id, "Implement the approved plan.", "agent", chat.model);
  }

  private async onMessage(msg: {
    type: string;
    content?: string;
    mode?: Mode;
    model?: string;
    id?: string;
    thinking?: string;
    attachments?: Array<{ name?: string; mime?: string; data?: string }>;
    mentions?: Mention[];
    seq?: number;
    query?: string;
    uris?: string[];
    paths?: string[];
    url?: string;
    fsPath?: string;
    monthly?: number;
    provider?: string;
    apiKey?: string;
    gcpProject?: string;
    azureEndpoint?: string;
    awsSecret?: string;
    awsRegion?: string;
    modelId?: string;
    ambient?: string;
    source?: string;
    ids?: string[];
  }): Promise<void> {
    try {
      switch (msg.type) {
        case "ready":
          await this.pushState();
          this.postChanges();
          void this.tokenPanel.publish();
          if (this.probeView.running || this.probeView.models.length || this.probeView.error || this.probeView.total) {
            this.postProbe();
          }
          this.flushMentions();
          {
            const auth = await this.accounts.publicState();
            if (auth.signedIn && auth.needsModelPick) {
              void this.refreshListed();
            }
          }
          break;
        case "enterApp":
          await this.finishSignIn(await this.accounts.enter());
          break;
        case "signOut":
          this.stopProbe();
          await this.accounts.signOut();
          this.tokenPanel.collapse();
          await this.pushState();
          break;
        case "saveKey":
          await this.saveKey(msg);
          break;
        case "startCloudLogin":
          await this.startCloudLogin();
          break;
        case "connectClaude":
          await this.connectClaude();
          break;
        case "connectChatGpt":
          await this.connectChatGpt();
          break;
        case "useAmbient":
          await this.finishCredential(await this.accounts.useAmbient(msg.ambient ?? ""));
          break;
        case "chooseModels":
          await this.chooseModels();
          break;
        case "startProbe":
          void this.refreshListed();
          break;
        case "stopProbe":
          this.stopProbe();
          break;
        case "saveModels":
          await this.saveModels(msg.ids ?? []);
          break;
        case "send":
          await this.handleSend(
            msg.content ?? "",
            msg.mode ?? "agent",
            msg.model,
            msg.thinking,
            msg.attachments,
            msg.mentions
          );
          break;
        case "mentionQuery":
          await this.replyMentionQuery(msg.query ?? "");
          break;
        case "dropUris":
          for (const uri of msg.uris ?? []) {
            await this.mentionFromTarget(uri);
          }
          break;
        case "dropPaths":
          for (const filePath of msg.paths ?? []) {
            await this.mentionFromTarget(filePath);
          }
          break;
        case "mentionAck":
          if (msg.id) {
            this.queuedMentions = this.queuedMentions.filter((mention) => mention.id !== msg.id);
          }
          break;
        case "cancel":
          await this.cancel();
          break;
        case "newChat":
          await this.newChat();
          break;
        case "selectChat":
          if (msg.id) {
            await this.store.setActive(msg.id);
            await this.pushState(msg.id);
            void this.tokenPanel.publish();
          }
          break;
        case "buildPlan":
          await this.buildPlan();
          break;
        case "openPlan":
          await this.openPlan();
          break;
        case "openTokens":
          await this.tokenPanel.reveal();
          this.post({ type: "open_tokens" });
          break;
        case "openDiff":
          if (msg.fsPath) {
            await vscode.commands.executeCommand("codecook.openDiff", msg.fsPath);
          }
          break;
        case "keepAll":
          await vscode.commands.executeCommand("codecook.keepAll");
          break;
        case "revertAll":
          await vscode.commands.executeCommand("codecook.revertAll");
          break;
        case "savingsReport":
          await this.tokenPanel.openSavingsReport();
          break;
        case "setLimits":
          await this.tokenPanel.setMonthlyLimit(msg.monthly ?? 0);
          break;
        case "summarize":
          await this.summarizeActive();
          break;
        case "restore":
          if (typeof msg.seq === "number") {
            await this.restoreRequest(msg.seq);
          }
          break;
        case "openLink":
          await this.openExternalLink(msg.url);
          break;
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.post({ type: "error", error });
      void vscode.window.showErrorMessage(`CodeCook: ${error}`);
    }
  }

  private async handleSend(
    content: string,
    mode: Mode,
    model?: string,
    thinking?: string,
    incoming?: Array<{ name?: string; mime?: string; data?: string }>,
    incomingMentions?: Mention[]
  ): Promise<void> {
    const folder = getWorkspaceFolder();
    if (!folder) {
      this.post({ type: "error", error: "Open a folder before using CodeCook." });
      return;
    }
    const text = content.trim();
    const files = incoming ?? [];
    const mentions = (incomingMentions ?? []).slice(0, 8);
    if (!text && !files.length && !mentions.length) {
      return;
    }
    if (this.abort) {
      this.post({ type: "error", error: "A turn is already running." });
      return;
    }
    let chat = await this.store.getActiveChat();
    if (!chat) {
      chat = await this.store.createChat(mode, model);
    } else {
      await this.store.updateChat(chat.id, { mode, model });
    }
    const saved: Attachment[] = [];
    for (const file of files) {
      try {
        const decoded = decodeAttachment(file);
        const stored = saveChatAttachment(chat.id, decoded.name, decoded.bytes);
        saved.push({ name: decoded.name, mime: decoded.mime, path: stored.path, kind: decoded.kind });
      } catch (err) {
        this.post({ type: "error", error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (!text && !saved.length && !mentions.length) {
      return;
    }
    const settings = loadSettings();
    const contextBlock = editorContext(settings.contextRefMaxChars);
    const mentionBlock = buildMentionBlocks(mentions, activeEditorRel(), (rel) => this.readMentionFile(folder.uri.fsPath, rel), settings.contextRefMaxChars);
    const body = attachmentPrompt(text, saved);
    const userContent = [contextBlock, mentionBlock, body].filter(Boolean).join("\n\n");
    const titleHint = text || mentions[0]?.label || saved[0]?.name || "";
    await this.startTurn(chat.id, userContent, mode, model, thinking, saved, mentions, titleHint);
  }

  async addToChat(mention: Mention): Promise<void> {
    try {
      await vscode.commands.executeCommand("codecook.chat.focus");
    } catch {
      try {
        await vscode.commands.executeCommand("workbench.view.extension.codecookSidebar");
      } catch {
        // The view may already be visible.
      }
    }
    const credential = await this.accounts.credential();
    if (!credential) {
      await this.pushState();
      this.post({ type: "auth_error", error: "Sign in and add a key before adding this to chat." });
      return;
    }
    this.enqueueMention(mention);
  }

  async addFilesToChat(uris: vscode.Uri[]): Promise<void> {
    try {
      await vscode.commands.executeCommand("codecook.chat.focus");
    } catch {
      try {
        await vscode.commands.executeCommand("workbench.view.extension.codecookSidebar");
      } catch {
        // The view may already be visible.
      }
    }
    const credential = await this.accounts.credential();
    if (!credential) {
      await this.pushState();
      this.post({ type: "auth_error", error: "Sign in and add a key before adding files to chat." });
      return;
    }
    for (const uri of uris) {
      await this.mentionFromTarget(uri.toString());
    }
  }

  private enqueueMention(mention: Mention): void {
    const queued: Mention = {
      ...mention,
      id: mention.id || `q${Date.now().toString(36)}${this.queuedMentions.length}`,
    };
    if (this.queuedMentions.some((item) => item.id === queued.id)) {
      this.flushMentions();
      return;
    }
    this.queuedMentions.push(queued);
    this.flushMentions();
  }

  private flushMentions(): void {
    if (!this.view || !this.queuedMentions.length) {
      return;
    }
    for (const mention of this.queuedMentions) {
      void this.view.webview.postMessage({ type: "mention", mention });
    }
  }

  private async replyMentionQuery(query: string): Promise<void> {
    const files = await this.searchMentionFiles(query);
    this.post({ type: "mentionResults", query, files });
  }

  private async searchMentionFiles(query: string): Promise<string[]> {
    const folder = getWorkspaceFolder();
    if (!folder) {
      return [];
    }
    const needle = query.replace(/[*?[\]{}]/g, "").trim().toLowerCase();
    const results: string[] = [];
    const seen = new Set<string>();
    const push = (rel: string) => {
      const norm = rel.replace(/\\/g, "/").replace(/^\.\//, "");
      if (!norm || norm.startsWith("..") || norm.includes("node_modules/") || norm.split("/").includes(".git")) {
        return;
      }
      if (needle && !norm.toLowerCase().includes(needle)) {
        return;
      }
      if (seen.has(norm)) {
        return;
      }
      seen.add(norm);
      results.push(norm);
    };
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.scheme !== "file") {
        continue;
      }
      push(path.relative(folder.uri.fsPath, editor.document.uri.fsPath));
      if (results.length >= 20) {
        return results;
      }
    }
    const segment = needle.split("/").filter(Boolean).pop() || "";
    const pattern = segment ? `**/*${segment}*` : "**/*";
    try {
      const hits = await vscode.workspace.findFiles(pattern, "**/{node_modules,.git}/**", 400);
      for (const uri of hits) {
        push(path.relative(folder.uri.fsPath, uri.fsPath));
        if (results.length >= 20) {
          break;
        }
      }
    } catch {
      // An unreadable workspace still leaves the open editors.
    }
    return results;
  }

  private async mentionFromTarget(target: string): Promise<void> {
    const folder = getWorkspaceFolder();
    const raw = target.trim().replace(/^"|"$/g, "");
    if (!raw) {
      return;
    }
    if (!folder) {
      this.post({ type: "error", error: "Open a folder in your editor before dropping files into CodeCook." });
      return;
    }
    const fsPath = pathFromDrop(raw, folder.uri.fsPath);
    if (!fsPath) {
      this.post({ type: "error", error: "That drop did not include a file path." });
      return;
    }
    const rel = path.relative(folder.uri.fsPath, fsPath);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      let stat: vscode.FileStat;
      try {
        stat = await vscode.workspace.fs.stat(vscode.Uri.file(fsPath));
      } catch {
        this.post({ type: "error", error: `Cannot read ${path.basename(fsPath)}.` });
        return;
      }
      if (stat.type & vscode.FileType.Directory) {
        this.post({ type: "status", message: "Drop a file. Folders are not added to the chat." });
        return;
      }
      const mentionPath = rel.replace(/\\/g, "/");
      if (/\.(pdf|docx|doc)$/i.test(mentionPath)) {
        await this.attachExternal(vscode.Uri.file(fsPath));
        return;
      }
      this.enqueueMention({ kind: "file", label: mentionPath, path: mentionPath });
      return;
    }
    await this.attachExternal(vscode.Uri.file(fsPath));
  }

  private async attachExternal(uri: vscode.Uri): Promise<void> {
    const name = path.basename(uri.fsPath);
    if (!attachmentKind(name)) {
      this.post({ type: "error", error: `Cannot attach ${name}. Use an image, PDF, Word, HTML, or text file.` });
      return;
    }
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch {
      this.post({ type: "error", error: `Cannot attach ${name}.` });
      return;
    }
    if (bytes.byteLength > 8 * 1024 * 1024) {
      this.post({ type: "error", error: `${name} is larger than 8 MB.` });
      return;
    }
    let decoded;
    try {
      decoded = decodeAttachment({ name, data: Buffer.from(bytes).toString("base64") });
    } catch (err) {
      this.post({ type: "error", error: err instanceof Error ? err.message : String(err) });
      return;
    }
    this.post({
      type: "dropAttach",
      name: decoded.name,
      mime: decoded.mime,
      data: Buffer.from(decoded.bytes).toString("base64"),
    });
  }

  private readMentionFile(root: string, rel: string): { text: string; binary: boolean } | undefined {
    try {
      const abs = resolveWorkspacePath(rel, root);
      const bytes = fs.readFileSync(abs);
      if (isBinaryMention(rel, bytes)) {
        return { text: "", binary: true };
      }
      return { text: bytes.toString("utf8"), binary: false };
    } catch {
      return undefined;
    }
  }

  private async restoreRequest(seq: number): Promise<void> {
    if (this.abort) {
      this.post({ type: "error", error: "Stop the current turn before restoring." });
      return;
    }
    const chat = await this.store.getActiveChat();
    if (!chat) {
      this.post({ type: "error", error: "No chat to restore." });
      return;
    }
    const later = chat.messages.some((message) => message.seq > seq);
    const restored = await this.tracker.restoreCheckpoint(chat.id, seq);
    if (!restored.found && !later) {
      this.post({ type: "status", message: "Nothing to restore." });
      return;
    }
    await this.store.rewindToRequest(
      chat.id,
      seq,
      restored.found ? { plan: restored.plan ?? null, todos: restored.todos ?? null } : undefined
    );
    if (restored.found) {
      if (restored.plan || restored.todos?.length) {
        this.planPanel.show(restored.plan ?? undefined, restored.todos ?? undefined);
      } else {
        this.planPanel.clear();
      }
    }
    await this.pushState(chat.id);
    this.post({
      type: "status",
      message: restored.count
        ? `Restored ${restored.count} file${restored.count === 1 ? "" : "s"}.`
        : "Restored this request.",
    });
  }

  private async openExternalLink(raw?: string): Promise<void> {
    if (!raw) {
      return;
    }
    let parsed: vscode.Uri;
    try {
      parsed = vscode.Uri.parse(raw);
    } catch {
      return;
    }
    if (parsed.scheme !== "http" && parsed.scheme !== "https") {
      return;
    }
    await vscode.env.openExternal(parsed);
  }

  private async startTurn(
    chatId: string,
    userContent: string,
    mode: Mode,
    model?: string,
    thinking?: string,
    attachments?: Attachment[],
    mentions?: Mention[],
    titleHint?: string
  ): Promise<void> {
    const credential = await this.requireCredential();
    if (!credential) {
      return;
    }
    const chat = await this.store.getChat(chatId);
    if (!chat) {
      this.post({ type: "error", error: "Chat not found" });
      return;
    }
    this.abort = new AbortController();
    this.turnError = undefined;
    this.runningChatId = chatId;
    this.lastChatId = chatId;
    this.tracker.beginTurn();
    this.post({ type: "chat_id", chat_id: chatId });
    this.post({ type: "turn_started" });
    const settings = loadSettings();
    const loop = new AgentLoop(this.store, settings, (event) => this.onTurnEvent(event), this.tracker, this.usage);
    loop.useCredential(credential);
    loop.useModelList(this.accounts.cachedModelIds());
    try {
      await loop.run(
        chat,
        userContent,
        mode,
        model,
        this.abort.signal,
        thinking,
        attachments,
        mentions,
        titleHint
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.turnError = error;
      this.post({ type: "error", error });
    } finally {
      this.abort = undefined;
      this.runningChatId = undefined;
      this.post({ type: "turn_ended" });
      if (this.tracker.list().length) {
        this.onChangesReady();
      }
      await this.pushState(chatId);
      if (this.turnError) {
        this.post({ type: "error", error: this.turnError });
      }
    }
  }

  private onTurnEvent(event: TurnEvent): void {
    if (event.type === "error") {
      this.turnError = event.error;
    }
    this.post(event);
    if (event.type === "todos_updated") {
      this.planPanel.show(event.plan, event.todos);
    }
    if (event.type === "context" || event.type === "usage") {
      this.tokenPanel.update(event);
    }
  }

  activeChatId(): string | undefined {
    return this.runningChatId ?? this.lastChatId;
  }

  async openPlan(): Promise<void> {
    const chat = await this.store.getActiveChat();
    if (!chat?.plan && !chat?.todos?.length) {
      this.post({ type: "error", error: "No plan to open." });
      return;
    }
    this.planPanel.show(chat.plan, chat.todos);
  }

  private async pushState(activeId?: string): Promise<void> {
    if (!getWorkspaceFolder()) {
      this.setSignedIn(false);
      this.post({
        type: "state",
        chats: [],
        activeChat: null,
        models: [],
        defaultModel: loadSettings().model,
        noWorkspace: true,
        auth: { signedIn: false, needsKey: true, needsModelPick: false, models: [], listed: [], failed: [], working: [], ambient: [] },
      });
      return;
    }
    const chats = await this.store.listChats();
    const active = activeId ? await this.store.getChat(activeId) : await this.store.getActiveChat();
    const auth = await this.accounts.publicState();
    this.lastChatId = active?.id;
    this.setSignedIn(auth.signedIn);
    this.post({
      type: "state",
      chats: chats.map((c) => ({ id: c.id, title: c.title, mode: c.mode })),
      activeChat: active ?? null,
      models: auth.models,
      defaultModel: loadSettings().model,
      noWorkspace: false,
      auth,
    });
  }

  private async requireCredential() {
    const credential = await this.accounts.credential();
    if (credential && this.accounts.cachedModelIds().length) {
      return credential;
    }
    await this.pushState();
    const auth = await this.accounts.publicState();
    const error = !auth.signedIn
      ? "Sign in before using CodeCook."
        : !credential
        ? await this.accounts.blockedReason()
        : "Choose at least one model.";
    this.post({ type: "auth_error", error });
    return undefined;
  }

  private async finishSignIn(result: { ok: true } | { ok: false; error: string; ignored?: boolean }): Promise<void> {
    if (!result.ok && result.ignored) {
      return;
    }
    if (!result.ok) {
      this.post({ type: "auth_error", error: result.error });
    }
    await this.pushState();
    if (result.ok) {
      const auth = await this.accounts.publicState();
      if (auth.needsModelPick && !auth.listed.length) {
        void this.refreshListed();
      }
    }
  }

  private async saveKey(msg: {
    provider?: string;
    apiKey?: string;
    gcpProject?: string;
    azureEndpoint?: string;
    awsSecret?: string;
    awsRegion?: string;
    modelId?: string;
    source?: string;
  }): Promise<void> {
    await this.finishCredential(
      await this.accounts.saveCredential({
        provider: msg.provider,
        source: msg.source,
        apiKey: msg.apiKey,
        gcpProject: msg.gcpProject,
        azureEndpoint: msg.azureEndpoint,
        awsSecret: msg.awsSecret,
        awsRegion: msg.awsRegion,
        model: msg.modelId,
      })
    );
  }

  private async finishCredential(result: { ok: true } | { ok: false; error: string }): Promise<void> {
    if (!result.ok) {
      this.post({ type: "auth_error", error: result.error });
    } else {
      this.post({ type: "key_saved" });
    }
    await this.pushState();
    if (result.ok) {
      void this.refreshListed();
    }
  }

  private stopProbe(): void {
    this.probeAbort?.abort();
  }

  private async chooseModels(): Promise<void> {
    const credential = await this.accounts.credential();
    if (!credential) {
      this.post({ type: "auth_error", error: "Add an API key or cloud login for this account." });
      return;
    }
    if (this.probeAbort) {
      this.postProbe();
      return;
    }
    void this.refreshListed();
  }

  private async refreshListed(): Promise<void> {
    this.postModelList({ listed: [], failed: [] });
    let warning = "";
    try {
      const listed = await this.accounts.refreshListed();
      warning = listed.warning || "";
    } catch (err) {
      this.probeView = {
        running: false,
        done: 0,
        total: 0,
        failed: 0,
        models: [],
        error: err instanceof Error ? err.message : String(err),
      };
      this.postProbe();
      return;
    }
    const auth = await this.accounts.publicState();
    this.probeView = { running: false, done: 0, total: 0, failed: auth.failed.length, models: auth.listed, error: warning || undefined };
    this.postModelList(auth, warning);
    await this.pushState();
  }

  private postModelList(auth: { listed: Array<{ id: string; label: string }>; failed: string[] }, error = ""): void {
    this.post({ type: "model_list", models: auth.listed, failed: auth.failed, error });
  }

  private async saveModels(ids: string[]): Promise<void> {
    const selection = this.accounts.prepareSelection(ids);
    if (!selection.pending.length && !selection.enabled.length) {
      this.probeView.error = "Choose at least one model.";
      this.postProbe();
      return;
    }
    if (!selection.pending.length) {
      this.probeView.error = undefined;
      await this.pushState();
      this.post({ type: "models_saved" });
      return;
    }
    await this.startProbe(selection.pending);
  }

  private async startProbe(ids: string[]): Promise<void> {
    if (!ids.length) {
      return;
    }
    if (this.probeAbort) {
      this.postProbe();
      return;
    }
    const gen = ++this.probeGen;
    const stop = new AbortController();
    this.probeAbort = stop;
    const credential = await this.accounts.credential();
    this.probeView = { running: true, done: 0, total: ids.length, failed: 0, models: [], error: undefined };
    this.postProbe();
    let stopped = false;
    try {
      if (!credential || gen !== this.probeGen) {
        return;
      }
      const client = createLlmClient({ ...loadSettings(), llmMaxCompletionTokens: PROBE_OUTPUT_TOKENS }, credential);
      await probeModelIds(client, ids, stop.signal, (update) => {
        if (gen !== this.probeGen) {
          return;
        }
        this.probeView.done = update.done;
        this.probeView.failed = update.failed;
        this.probeView.models = update.working.map((id) => ({ id, label: id }));
        if (update.fatal) {
          this.probeView.error = update.fatal;
        }
        for (const id of update.working) {
          this.accounts.rememberProbe(id, true);
        }
        for (const id of update.failedIds) {
          this.accounts.rememberProbe(id, false);
        }
        this.post({
          type: "model_probe",
          running: true,
          done: update.done,
          total: update.total,
          failed: update.failed,
          failedIds: update.failedIds,
          models: this.probeView.models,
          error: this.probeView.error ?? "",
        });
      });
      stopped = stop.signal.aborted;
    } finally {
      if (this.probeAbort === stop) {
        this.probeAbort = undefined;
      }
      if (gen !== this.probeGen) {
        return;
      }
      this.probeView.running = false;
      const auth = await this.accounts.publicState();
      if (!auth.models.length && !this.probeView.error && !stopped) {
        this.probeView.error = "No model accepted a reply. Check the key and try again.";
      }
      this.post({
        type: "model_probe",
        running: false,
        done: this.probeView.done,
        total: this.probeView.total,
        failed: auth.failed.length,
        failedIds: auth.failed,
        models: this.probeView.models,
        error: this.probeView.error ?? "",
      });
      if (auth.models.length && !stopped) {
        await this.pushState();
        this.post({ type: "models_saved" });
      }
    }
  }

  private postProbe(): void {
    this.post({
      type: "model_probe",
      running: this.probeView.running,
      done: this.probeView.done,
      total: this.probeView.total,
      failed: this.probeView.failed,
      models: this.probeView.models,
      error: this.probeView.error ?? "",
    });
  }

  private async connectClaude(): Promise<void> {
    await vscode.env.openExternal(vscode.Uri.parse("https://console.anthropic.com/settings/keys"));
    this.post({ type: "show_key_form", provider: "anthropic" });
  }

  private async connectChatGpt(): Promise<void> {
    await vscode.env.openExternal(vscode.Uri.parse("https://platform.openai.com/api-keys"));
    this.post({ type: "show_key_form", provider: "openai" });
  }

  private async startCloudLogin(): Promise<void> {
    const installed = await gcloudOk(["--version"]);
    if (!installed) {
      this.post({ type: "auth_error", error: "The Google Cloud CLI is not installed. Install gcloud, or use an API key." });
      return;
    }
    const term = vscode.window.createTerminal({ name: "CodeCook Google Cloud" });
    term.show();
    term.sendText("gcloud auth application-default login");
    this.post({ type: "auth_error", error: "Finish the Google Cloud login in the terminal, enter your project, then choose Continue." });
  }

  postChanges(): void {
    this.post({
      type: "changes",
      files: this.tracker.list().map((file) => ({
        rel: file.rel,
        fsPath: file.fsPath,
        created: file.created,
      })),
    });
  }

  showTokenStats(snapshot: TokenSnapshot): void {
    this.post({ type: "tokens", tokens: snapshot });
  }

  openTokenSection(): void {
    void this.tokenPanel.reveal().then(() => this.post({ type: "open_tokens" }));
    void vscode.commands.executeCommand("codecook.chat.focus");
  }

  openChangesSection(): void {
    this.postChanges();
    this.post({ type: "open_changes" });
    void vscode.commands.executeCommand("codecook.chat.focus");
  }

  syncAuthContext(): void {
    this.setSignedIn(this.accounts.hasSession());
  }

  private setSignedIn(signedIn: boolean): void {
    void vscode.commands.executeCommand("setContext", "codecook.signedIn", signedIn);
  }

  private post(event: TurnEvent | Record<string, unknown>): void {
    this.view?.webview.postMessage(event);
  }

  private html(): string {
    const media = path.join(this.context.extensionPath, "media");
    const css = fs.readFileSync(path.join(media, "chat.css"), "utf8");
    const js = fs.readFileSync(path.join(media, "chat.js"), "utf8");
    const logo = fs.readFileSync(path.join(media, "logo.png")).toString("base64");
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">${css}</style>
</head>
<body>
  <div id="app">
    <header class="bar hidden">
      <select id="chat-list"></select>
      <button id="btn-new" title="New chat">+</button>
      <div class="header-pop">
        <button type="button" id="changes-toggle" class="header-chip" title="Changes" aria-expanded="false" aria-label="Changes">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"></path><path d="M14 3v6h6M8 13h8M8 17h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path></svg>
          <span id="changes-count">0</span>
        </button>
        <div id="changes-menu" class="chat-pop hidden" role="dialog" aria-label="Changes">
          <p id="changes-empty" class="pop-empty">File edits from the current turn appear here.</p>
          <div id="changes-list"></div>
          <div id="changes-actions" class="pop-actions hidden">
            <button type="button" id="btn-keep-all">Keep all</button>
            <button type="button" id="btn-revert-all">Revert all</button>
          </div>
        </div>
      </div>
      <div class="header-pop">
        <button type="button" id="token-toggle" class="header-chip" title="Saved this turn" aria-expanded="false" aria-label="Saved this turn">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.8"></circle><path d="M12 8v4l2.5 1.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path></svg>
          <span id="token-summary">0%</span>
        </button>
        <div id="token-menu" class="chat-pop hidden" role="dialog" aria-label="Token optimizer">
          <div id="token-activity" class="pop-activity hidden"><span class="spinner" aria-hidden="true"></span><span id="token-activity-label"></span></div>
          <div class="token-head">
            <strong>CodeCook</strong>
            <span id="token-model" class="token-pill">—</span>
          </div>
          <div class="token-donut">
            <svg viewBox="0 0 140 140" aria-hidden="true">
              <g transform="rotate(-90 70 70)">
                <circle cx="70" cy="70" r="52" class="token-track token-track-outer"></circle>
                <circle id="token-arc-saved" cx="70" cy="70" r="52" class="token-arc token-arc-saved"></circle>
                <circle cx="70" cy="70" r="34" class="token-track token-track-inner"></circle>
                <circle id="token-arc-cache" cx="70" cy="70" r="34" class="token-arc token-arc-cache"></circle>
              </g>
            </svg>
            <div class="token-donut-copy">
              <b id="token-saved-pct">0%</b>
              <span>saved this turn</span>
            </div>
          </div>
          <div class="token-legend">
            <span><i class="token-dot saved"></i> Saved <b id="token-saved-legend">0</b></span>
            <span id="token-cache-wrap"><i class="token-dot cache"></i> Cache hit <b id="token-cache-legend">—</b></span>
          </div>
          <div class="token-compare">
            <div class="token-compare-row"><span>Without compression</span><b id="token-without">0 tokens</b></div>
            <div class="token-meter"><span id="token-without-bar"></span></div>
            <div class="token-compare-row"><span>With compression</span><b id="token-with">0 tokens</b></div>
            <div class="token-meter"><span id="token-with-bar" class="fill"></span></div>
          </div>
          <div class="token-pair">
            <div class="token-stat"><span>Cost this turn</span><b id="token-cost">$0.00</b></div>
            <div class="token-stat"><span>Saved this session</span><b id="token-session-tokens">0</b></div>
          </div>
          <div class="token-meter-block">
            <div class="token-compare-row"><span>Context window</span><b id="token-context">0 / 1M</b></div>
            <div class="token-meter thin"><span id="token-context-bar" class="fill"></span></div>
          </div>
          <div id="token-month-row" class="token-meter-block">
            <div class="token-compare-row"><span>Monthly cap</span><b id="token-month">$0.00 · No cap</b></div>
            <div class="token-meter thin"><span id="token-month-bar" class="cap"></span></div>
          </div>
          <p id="token-projected" class="token-projected">Projected this month: about $0.00</p>
          <button type="button" id="token-details-toggle" class="token-details-btn" aria-expanded="false">Show details</button>
          <div id="token-details" class="token-details hidden">
            <div class="token-row"><span>Saved this turn</span><b id="token-saved-turn">~$0.00</b></div>
            <div class="token-row"><span>Saved this session</span><b id="token-session-usd">~$0.00</b></div>
            <div class="token-row"><span>Your message (tokens)</span><b id="token-user">0</b></div>
            <div class="token-row"><span>Input (tokens)</span><b id="token-prompt">0</b></div>
            <div class="token-row"><span>Output (tokens)</span><b id="token-output">0</b></div>
            <div class="token-row"><span>Cache</span><b id="token-cached">—</b></div>
            <div id="token-uncached-row" class="token-row hidden"><span>Without cache</span><b id="token-uncached">$0.00</b></div>
            <div class="token-row"><span>Cache discount this session</span><b id="token-session-cache">~$0.00</b></div>
            <div class="token-row"><span>Summaries this session</span><b id="token-summaries">0</b></div>
            <label class="token-limit">Monthly cap (USD)<input id="token-limit" type="number" min="0" step="0.01" placeholder="0 = no cap"></label>
            <div class="pop-actions">
              <button type="button" id="btn-summarize">Summarize chat</button>
              <button type="button" id="btn-savings">Savings report</button>
            </div>
          </div>
        </div>
      </div>
      <button id="btn-account" class="icon-btn hidden" title="Account" aria-label="Account">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="8" r="3.2" fill="none" stroke="currentColor" stroke-width="1.8"></circle>
          <path d="M5 19.2c1.2-3.2 3.8-4.7 7-4.7s5.8 1.5 7 4.7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path>
        </svg>
      </button>
      <div id="account-menu" class="account-menu hidden" role="menu">
        <div class="account-head">
          <span id="account-avatar" class="account-avatar">A</span>
          <div class="account-id">
            <strong id="account-name">Account</strong>
            <span id="account-role">Signed in</span>
          </div>
        </div>
        <div class="account-sep"></div>
        <button type="button" id="btn-connect-chatgpt-menu" class="menu-row" role="menuitem">Create Chatgpt Key</button>
        <button type="button" id="btn-connect-claude-menu" class="menu-row" role="menuitem">Create Claude Key</button>
        <button type="button" id="btn-use-key" class="menu-row" role="menuitem">Use API key</button>
        <button type="button" id="btn-choose-models" class="menu-row" role="menuitem">Choose models</button>
        <div class="account-sep"></div>
        <button type="button" id="btn-signout" class="menu-row danger" role="menuitem">Sign out</button>
      </div>
    </header>
    <div id="login-gate" class="gate hidden">
      <div id="code-matrix" class="code-matrix" aria-hidden="true"></div>
      <div class="login-panel">
        <div class="brand-mark">
          <img class="brand-logo" alt="" src="data:image/png;base64,${logo}" />
        </div>
        <h1>CodeCook</h1>
        <p class="gate-sub login-tag">High quality, less cost.</p>
        <div class="signin-actions">
          <button type="button" id="btn-enter" class="gate-primary">Enter</button>
        </div>
        <p id="login-error" class="gate-error"></p>
      </div>
    </div>
    <div id="key-gate" class="gate hidden">
      <h1>CodeCook</h1>
      <p class="gate-sub">Add a key for this account.</p>
      <button type="button" id="btn-connect-chatgpt" class="gate-primary">Create Chatgpt Key</button>
      <button type="button" id="btn-connect-claude" class="gate-secondary">Create Claude Key</button>
      <button type="button" id="btn-show-key" class="gate-secondary">Use API key</button>
      <button type="button" id="btn-show-cloud" class="gate-secondary">Use cloud login</button>
      <button type="button" id="btn-show-more" class="gate-link">More options</button>
      <form id="api-key-form" class="hidden">
        <select id="key-provider">
          <option value="google">Google</option>
          <option value="openai">ChatGPT</option>
          <option value="anthropic">Claude</option>
          <option value="azure">Azure</option>
          <option value="aws">AWS</option>
        </select>
        <input id="key-value" type="password" placeholder="API key" />
        <input id="key-azure" class="hidden" placeholder="Azure OpenAI endpoint" />
        <input id="key-aws-secret" class="hidden" type="password" placeholder="AWS secret key" />
        <input id="key-aws-region" class="hidden" placeholder="AWS region" />
        <input id="key-model" placeholder="Model id (optional)" />
        <button type="submit" class="gate-primary">Save key</button>
        <p id="key-hint" class="gate-sub hidden">Create a key in the browser, paste it here, then save.</p>
      </form>
      <form id="cloud-form" class="hidden">
        <input id="cloud-project" placeholder="Your Google Cloud project" />
        <button type="submit" class="gate-primary">Continue</button>
      </form>
      <div id="more-box" class="hidden"></div>
      <button type="button" id="btn-key-cancel" class="gate-link hidden">Cancel</button>
      <button type="button" id="btn-key-signout" class="gate-link">Sign out</button>
      <p id="key-error" class="gate-error"></p>
    </div>
    <div id="model-gate" class="gate hidden">
      <h1>CodeCook</h1>
      <p id="model-progress" class="gate-sub">Loading models…</p>
      <div id="model-bulk" class="model-bulk hidden">
        <button type="button" id="btn-model-all" class="gate-secondary">Select all</button>
        <button type="button" id="btn-model-none" class="gate-secondary">Unselect all</button>
      </div>
      <div id="model-checks"></div>
      <button type="button" id="btn-model-stop" class="gate-secondary hidden">Stop</button>
      <button type="button" id="btn-model-test" class="gate-secondary hidden">Try again</button>
      <button type="button" id="btn-model-continue" class="gate-primary" disabled>Continue</button>
      <button type="button" id="btn-model-back" class="gate-link">Back</button>
      <p id="model-error" class="gate-error"></p>
    </div>
    <div id="messages"><div class="empty">Ask CodeCook to read, edit, or plan work in this folder.</div></div>
    <div id="activity" class="hidden"><span class="spinner" aria-hidden="true"></span><span id="activity-label"></span></div>
    <div id="banner" class="hidden"></div>
    <footer class="composer">
        <div class="composer-box">
        <div id="mention-menu" class="mention-menu hidden"></div>
        <div id="attach-chips" class="attach-chips"></div>
        <textarea id="input" rows="2" placeholder="Ask CodeCook… Right-click a file and choose Add to CodeCook Chat"></textarea>
        <div class="composer-actions">
          <button type="button" id="btn-attach" class="icon-btn" title="Attach a file" aria-label="Attach a file">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M21.4 11.1 12.3 20.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.6 5.7l-9.2 9.1a2 2 0 0 1-2.8-2.8l8.5-8.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>
            </svg>
          </button>
          <input id="file-attach" type="file" multiple hidden accept=".png,.jpg,.jpeg,.webp,.gif,.pdf,.docx,.doc,.html,.htm,.txt,.md">
          <div class="model-picker">
            <button type="button" id="mode-btn" title="Chat, Agent, or Plan" aria-haspopup="menu" aria-expanded="false">Agent</button>
            <div id="mode-menu" class="model-menu hidden" role="menu"></div>
          </div>
          <div class="model-picker">
            <button type="button" id="model-btn" title="Model, thinking, and history">Auto</button>
            <div id="model-menu" class="model-menu hidden"></div>
          </div>
          <button id="token-ring" class="ring" title="0% of summarize budget" aria-label="Open token optimizer">
            <svg viewBox="0 0 36 36">
              <circle class="bg" cx="18" cy="18" r="15.5"></circle>
              <circle id="ring" class="fg" cx="18" cy="18" r="15.5"></circle>
            </svg>
          </button>
          <button id="btn-send" class="icon-btn" title="Send" aria-label="Send">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M22 2 11 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>
              <path d="M22 2 15 22 11 13 2 9 22 2z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>
            </svg>
          </button>
          <button id="btn-cancel" class="hidden">Stop</button>
        </div>
      </div>
    </footer>
  </div>
  <script nonce="${nonce}">${js}</script>
</body>
</html>`;
  }
}

function pathFromDrop(raw: string, workspaceRoot: string): string {
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) {
    return path.isAbsolute(raw) ? raw : path.resolve(workspaceRoot, raw);
  }
  let uri: vscode.Uri;
  try {
    uri = vscode.Uri.parse(raw);
  } catch {
    return "";
  }
  if (uri.scheme === "file") {
    return uri.fsPath;
  }
  let filePath = uri.path || "";
  try {
    filePath = decodeURIComponent(filePath);
  } catch {
    // Keep the original path when it is not encoded.
  }
  if (/^\/[a-zA-Z]:/.test(filePath)) {
    filePath = filePath.slice(1);
  }
  return filePath.replace(/\//g, path.sep);
}

function gcloudOk(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("gcloud", args, { timeout: 8000, windowsHide: true }, (err) => resolve(!err));
  });
}

function activeEditorRel(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  const folder = getWorkspaceFolder();
  if (!editor || !folder || editor.document.uri.scheme !== "file") {
    return undefined;
  }
  const rel = path.relative(folder.uri.fsPath, editor.document.uri.fsPath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return undefined;
  }
  return rel.replace(/\\/g, "/");
}

function editorContext(maxChars: number): string {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return "";
  }
  const rel = activeEditorRel() || vscode.workspace.asRelativePath(editor.document.uri);
  const selection = editor.document.getText(editor.selection);
  if (selection) {
    const start = editor.selection.start.line + 1;
    const end = editor.selection.end.line + 1;
    return `--- Context file: ${rel} ---\nSelected lines ${start}-${end}:\n${middleTruncate(selection, maxChars)}\n--- End context file ---`;
  }
  return `--- Context file: ${rel} ---`;
}
