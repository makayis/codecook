import * as vscode from "vscode";
import * as crypto from "crypto";
import type { Chat, Message, Plan, StoreData, Todo } from "./types";

function workspaceKey(folder: vscode.Uri): string {
  return crypto.createHash("sha1").update(folder.fsPath).digest("hex").slice(0, 16);
}

export class ChatStore {
  private queue: Promise<unknown> = Promise.resolve();
  private cache: StoreData | null = null;
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
    const folder = getWorkspaceFolder();
    if (!folder) {
      throw new Error("Open a folder before using CodeCook.");
    }
    const root = this.context.storageUri ?? this.context.globalStorageUri;
    if (!root) {
      throw new Error("Extension storage is not available.");
    }
    await vscode.workspace.fs.createDirectory(root);
    this.fileUri = vscode.Uri.joinPath(root, `chats-${workspaceKey(folder.uri)}.json`);
    return this.fileUri;
  }

  private async ensureLoaded(): Promise<StoreData> {
    if (this.cache) {
      return this.cache;
    }
    const file = await this.resolveFile();
    try {
      const raw = await vscode.workspace.fs.readFile(file);
      this.cache = JSON.parse(Buffer.from(raw).toString("utf8")) as StoreData;
    } catch {
      this.cache = { chats: [], activeChatId: null };
    }
    return this.cache;
  }

  async load(): Promise<StoreData> {
    return this.run(() => this.ensureLoaded());
  }

  private async persist(): Promise<void> {
    if (!this.cache) {
      return;
    }
    const file = await this.resolveFile();
    const data = Buffer.from(JSON.stringify(this.cache, null, 2), "utf8");
    await vscode.workspace.fs.writeFile(file, data);
  }

  async listChats(): Promise<Chat[]> {
    const data = await this.load();
    return data.chats;
  }

  async getActiveChat(): Promise<Chat | undefined> {
    const data = await this.load();
    return data.chats.find((c) => c.id === data.activeChatId);
  }

  async getChat(id: string): Promise<Chat | undefined> {
    const data = await this.load();
    return data.chats.find((c) => c.id === id);
  }

  async createChat(mode: Chat["mode"] = "agent", model?: string): Promise<Chat> {
    return this.run(async () => {
      await this.ensureLoaded();
      const chat: Chat = {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        title: "New Chat",
        mode,
        model,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
      };
      this.cache!.chats.unshift(chat);
      this.cache!.activeChatId = chat.id;
      await this.persist();
      return chat;
    });
  }

  async setActive(id: string): Promise<Chat | undefined> {
    return this.run(async () => {
      const data = await this.ensureLoaded();
      const chat = data.chats.find((c) => c.id === id);
      if (chat) {
        data.activeChatId = id;
        await this.persist();
      }
      return chat;
    });
  }

  async updateChat(id: string, patch: Partial<Chat>): Promise<Chat | undefined> {
    return this.run(async () => {
      const data = await this.ensureLoaded();
      const chat = data.chats.find((c) => c.id === id);
      if (!chat) {
        return undefined;
      }
      Object.assign(chat, patch, { updatedAt: Date.now() });
      await this.persist();
      return chat;
    });
  }

  async saveMessage(chatId: string, message: Omit<Message, "seq"> & { seq?: number }): Promise<Message> {
    return this.run(async () => {
      const data = await this.ensureLoaded();
      const chat = data.chats.find((c) => c.id === chatId);
      if (!chat) {
        throw new Error("Chat not found");
      }
      const seq = message.seq ?? (chat.messages.length ? Math.max(...chat.messages.map((m) => m.seq)) + 1 : 0);
      const saved: Message = { ...message, seq };
      chat.messages.push(saved);
      chat.updatedAt = Date.now();
      await this.persist();
      return saved;
    });
  }

  async patchMessage(chatId: string, seq: number, patch: Partial<Pick<Message, "content" | "attachments">>): Promise<void> {
    return this.run(async () => {
      const data = await this.ensureLoaded();
      const msg = data.chats.find((c) => c.id === chatId)?.messages.find((m) => m.seq === seq);
      if (!msg) {
        return;
      }
      Object.assign(msg, patch);
      await this.persist();
    });
  }

  async updateToolCall(chatId: string, seq: number, index: number, status: string, result: string | null): Promise<void> {
    return this.run(async () => {
      const data = await this.ensureLoaded();
      const chat = data.chats.find((c) => c.id === chatId);
      const msg = chat?.messages.find((m) => m.seq === seq);
      if (!msg?.tool_calls?.[index]) {
        return;
      }
      msg.tool_calls[index].status = status;
      msg.tool_calls[index].result = result;
      await this.persist();
    });
  }

  async saveTodos(chatId: string, todos: Todo[]): Promise<void> {
    await this.updateChat(chatId, { todos });
  }

  async savePlan(chatId: string, plan: Plan): Promise<void> {
    await this.updateChat(chatId, { plan });
  }

  async saveSummary(chatId: string, summary: Chat["summary"]): Promise<void> {
    await this.updateChat(chatId, { summary });
  }

  async rewindToRequest(
    chatId: string,
    seq: number,
    state?: { plan?: Plan | null; todos?: Todo[] | null }
  ): Promise<void> {
    return this.run(async () => {
      const data = await this.ensureLoaded();
      const chat = data.chats.find((c) => c.id === chatId);
      if (!chat) {
        return;
      }
      chat.messages = chat.messages.filter((message) => message.seq <= seq);
      if (chat.summary && chat.summary.through_seq > seq) {
        chat.summary = undefined;
      }
      if (state) {
        chat.plan = state.plan ?? undefined;
        chat.todos = state.todos ?? undefined;
      }
      chat.updatedAt = Date.now();
      await this.persist();
    });
  }
}

export function getWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (folder) {
      return folder;
    }
  }
  return vscode.workspace.workspaceFolders?.[0];
}
