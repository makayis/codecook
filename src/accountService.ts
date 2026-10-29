import * as vscode from "vscode";
import {
  ambientChoices,
  ambientCredential,
  type AccountRecord,
  credentialFor,
  LOCAL_ACCOUNT,
  normalizeSaved,
  type CredentialInput,
  type SavedCredential,
  type SignInProvider,
} from "./accounts";
import { createHostId, needsChatGptRefresh, refreshChatGptSession, runChatGptSignIn } from "./chatgptAuth";
import { fetchModelIds } from "./modelList";
import { catalogFor, enabledModels, selectChatModels } from "./providers";
import type { ChatGptCredential, ProviderId, UserCredential } from "./types";

const USERS_KEY = "codecook.users";
const SESSION_KEY = "codecook.sessionUser";
const MODELS_KEY = "codecook.modelCache";
const HOST_ID_KEY = "codecook.chatgptHostId";

interface ModelCache {
  provider: ProviderId;
  listed: string[];
  working: string[];
  enabled: string[];
  failed: string[];
}

export interface PublicAuth {
  signedIn: boolean;
  username?: string;
  signInProvider?: SignInProvider;
  needsKey: boolean;
  needsModelPick: boolean;
  provider?: ProviderId;
  models: Array<{ id: string; label: string }>;
  listed: Array<{ id: string; label: string }>;
  failed: string[];
  working: Array<{ id: string; label: string }>;
  ambient: Array<{ id: string; label: string }>;
}

export class AccountService {
  private chatgptRefresh: Promise<unknown> = Promise.resolve();

  constructor(private readonly context: vscode.ExtensionContext) {}

  hasSession(): boolean {
    return Boolean(this.context.globalState.get<string>(SESSION_KEY));
  }

  async publicState(): Promise<PublicAuth> {
    const user = this.sessionUser();
    const ambient = ambientChoices(process.env);
    if (!user) {
      return { signedIn: false, needsKey: true, needsModelPick: false, models: catalogFor("google"), listed: [], failed: [], working: [], ambient };
    }
    const credential = await this.credentialFor(user);
    const provider = credential?.provider ?? "google";
    const enabled = this.enabledFor(user.id, provider);
    return {
      signedIn: true,
      username: user.label,
      signInProvider: user.provider,
      needsKey: !credential,
      needsModelPick: Boolean(credential) && enabled.length === 0,
      provider: credential?.provider,
      models: enabled.map((id) => ({ id, label: id })),
      listed: this.listedFor(user.id, provider),
      failed: this.failedFor(user.id, provider),
      working: this.workingFor(user.id, provider),
      ambient,
    };
  }

  async enter(): Promise<{ ok: true }> {
    const existing = this.readUsers();
    let target = existing.find((user) => user.id === LOCAL_ACCOUNT.id);
    if (!target) {
      const legacy = existing[existing.length - 1];
      if (legacy && await this.readSaved(legacy.id)) {
        target = legacy;
      } else {
        target = LOCAL_ACCOUNT;
        const users = existing.filter((user) => user.id !== target!.id);
        users.push(target);
        await this.context.globalState.update(USERS_KEY, users);
      }
    }
    await this.context.globalState.update(SESSION_KEY, target.id);
    return { ok: true };
  }

  async signOut(): Promise<void> {
    await this.context.globalState.update(SESSION_KEY, undefined);
  }

  async credential(): Promise<UserCredential | null> {
    const user = this.sessionUser();
    if (!user) {
      return null;
    }
    return this.credentialFor(user);
  }

  async saveCredential(input: CredentialInput): Promise<{ ok: true } | { ok: false; error: string }> {
    const user = this.sessionUser();
    if (!user) {
      return { ok: false, error: "Sign in before adding a key." };
    }
    const saved = normalizeSaved(input);
    if ("error" in saved) {
      return { ok: false, error: saved.error };
    }
    await this.context.secrets.store(this.secretKey(user.id), JSON.stringify(saved));
    this.writeCache(user.id, undefined);
    return { ok: true };
  }

  async useAmbient(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const saved = ambientCredential(id, process.env);
    if ("error" in saved) {
      return { ok: false, error: saved.error };
    }
    return this.saveCredential(saved);
  }

  async signInWithChatGpt(openBrowser: (url: string) => PromiseLike<boolean>): Promise<{ ok: true } | { ok: false; error: string; needsApiKey?: boolean }> {
    const user = this.sessionUser();
    if (!user) {
      return { ok: false, error: "Sign in before connecting ChatGPT." };
    }
    const previous = await this.readChatGpt(user.id);
    const result = await runChatGptSignIn({
      hostId: await this.ensureHostId(),
      previous,
      openBrowser: (url) => openBrowser(url),
    });
    if (result.session?.clientId) {
      await this.context.secrets.store(this.chatgptKey(user.id), JSON.stringify(result.session));
    }
    if (!result.ok || !result.session) {
      return { ok: false, error: result.error || "ChatGPT sign-in failed.", needsApiKey: result.needsApiKey };
    }
    const current = await this.readSaved(user.id);
    const saved: SavedCredential = {
      provider: "openai",
      source: "chatgpt-plan",
      model: current?.model,
      chatgpt: result.session,
    };
    await this.context.secrets.store(this.secretKey(user.id), JSON.stringify(saved));
    this.writeCache(user.id, undefined);
    return { ok: true };
  }

  async blockedReason(): Promise<string> {
    const user = this.sessionUser();
    if (!user) {
      return "Sign in before using CodeCook.";
    }
    const saved = await this.readSaved(user.id);
    if (saved?.source === "chatgpt-plan") {
      return "Sign in with ChatGPT again.";
    }
    return "Add an API key or cloud login for this account.";
  }

  cachedModelIds(): string[] {
    const user = this.sessionUser();
    if (!user) {
      return [];
    }
    const credential = this.cachedProvider(user.id);
    return credential?.enabled ?? [];
  }

  async listProbeIds(): Promise<{ ids: string[]; warning?: string }> {
    const user = this.sessionUser();
    if (!user) {
      throw new Error("Sign in before testing models.");
    }
    const credential = await this.credentialFor(user);
    if (!credential) {
      throw new Error(await this.blockedReason());
    }
    let warning: string | undefined;
    let live: string[] = [];
    try {
      live = await fetchModelIds(credential);
    } catch (err) {
      warning = err instanceof Error ? err.message : String(err);
      if (warning && credential.apiKey) {
        warning = warning.split(credential.apiKey).join("***");
      }
    }
    const typed = credential.model?.trim() || "";
    const liveIds = selectChatModels(credential.provider, typed ? [...live, typed] : live).map((item) => item.id);
    if (liveIds.length) {
      return { ids: liveIds };
    }
    const fallback = catalogFor(credential.provider, typed || undefined).map((item) => item.id);
    const ids = selectChatModels(credential.provider, typed ? [...fallback, typed] : fallback).map((item) => item.id);
    if (!ids.length) {
      throw new Error(warning || "No models were returned.");
    }
    const reason = warning || (credential.provider === "google"
      ? "Google did not return a model list. These are the built-in models."
      : "The provider did not return a model list. These are the built-in models.");
    return { ids, warning: reason };
  }

  async refreshListed(): Promise<{ ids: string[]; warning?: string }> {
    const user = this.sessionUser();
    if (!user) {
      throw new Error("Sign in before testing models.");
    }
    const credential = await this.credentialFor(user);
    if (!credential) {
      throw new Error(await this.blockedReason());
    }
    const listed = await this.listProbeIds();
    const previous = this.cachedProvider(user.id);
    const same = previous?.provider === credential.provider;
    const keep = (ids: string[] | undefined) => (same && ids ? ids.filter((id) => listed.ids.includes(id)) : []);
    this.writeCache(user.id, {
      provider: credential.provider,
      listed: listed.ids,
      working: keep(previous?.working),
      enabled: keep(previous?.enabled),
      failed: keep(previous?.failed),
    });
    return listed;
  }

  prepareSelection(checked: string[]): { pending: string[]; enabled: string[] } {
    const user = this.sessionUser();
    const cached = user ? this.cachedProvider(user.id) : undefined;
    if (!user || !cached) {
      return { pending: [], enabled: [] };
    }
    const allow = new Set(cached.listed);
    const chosen = checked.filter((id) => allow.has(id));
    const known = new Set(cached.working);
    const enabled = chosen.filter((id) => known.has(id));
    const pending = chosen.filter((id) => !known.has(id));
    const failed = cached.failed.filter((id) => !pending.includes(id));
    this.writeCache(user.id, { ...cached, enabled, failed });
    return { pending, enabled };
  }

  rememberProbe(id: string, ok: boolean): void {
    const user = this.sessionUser();
    const cached = user ? this.cachedProvider(user.id) : undefined;
    if (!user || !cached || !cached.listed.includes(id)) {
      return;
    }
    const working = ok ? [...new Set([...cached.working, id])] : cached.working.filter((item) => item !== id);
    const enabled = ok ? [...new Set([...cached.enabled, id])] : cached.enabled.filter((item) => item !== id);
    const failed = ok ? cached.failed.filter((item) => item !== id) : [...new Set([...cached.failed, id])];
    this.writeCache(user.id, { ...cached, working, enabled, failed });
  }

  setWorking(provider: ProviderId, working: string[]): void {
    const user = this.sessionUser();
    if (!user) {
      return;
    }
    const current = this.cachedProvider(user.id);
    const ids = [...new Set(working.filter(Boolean))];
    const enabled = current && current.provider === provider ? current.enabled.filter((id) => ids.includes(id)) : [];
    const listed = current && current.provider === provider && current.listed.length ? current.listed : ids;
    const failed = current && current.provider === provider ? current.failed.filter((id) => !ids.includes(id)) : [];
    this.writeCache(user.id, { provider, listed, working: ids, enabled, failed });
  }

  saveEnabled(ids: string[]): { ok: true } | { ok: false; error: string } {
    const user = this.sessionUser();
    if (!user) {
      return { ok: false, error: "Sign in before choosing models." };
    }
    const cached = this.cachedProvider(user.id);
    if (!cached) {
      return { ok: false, error: "Test the models before choosing them." };
    }
    const enabled = enabledModels(cached.working, ids);
    if (!enabled.length) {
      return { ok: false, error: "Choose at least one model." };
    }
    this.writeCache(user.id, { ...cached, enabled });
    return { ok: true };
  }

  private listedFor(username: string, provider: ProviderId): Array<{ id: string; label: string }> {
    const cached = this.cachedProvider(username);
    if (!cached || cached.provider !== provider) {
      return [];
    }
    return cached.listed.map((id) => ({ id, label: id }));
  }

  private failedFor(username: string, provider: ProviderId): string[] {
    const cached = this.cachedProvider(username);
    if (!cached || cached.provider !== provider) {
      return [];
    }
    return cached.failed;
  }

  private enabledFor(username: string, provider: ProviderId): string[] {
    const cached = this.cachedProvider(username);
    if (!cached || cached.provider !== provider) {
      return [];
    }
    return cached.enabled;
  }

  private workingFor(username: string, provider: ProviderId): Array<{ id: string; label: string }> {
    const cached = this.cachedProvider(username);
    if (!cached || cached.provider !== provider) {
      return [];
    }
    return cached.working.map((id) => ({ id, label: id }));
  }

  private cachedProvider(username: string): ModelCache | undefined {
    const all = this.context.globalState.get<Record<string, unknown>>(MODELS_KEY, {});
    const entry = all?.[username];
    if (!entry || typeof entry !== "object") {
      return undefined;
    }
    const record = entry as { provider?: ProviderId; listed?: unknown; working?: unknown; enabled?: unknown; failed?: unknown };
    if (!record.provider || (!Array.isArray(record.listed) && !Array.isArray(record.working))) {
      return undefined;
    }
    const working = Array.isArray(record.working)
      ? record.working.filter((id): id is string => typeof id === "string" && Boolean(id))
      : [];
    const listed = Array.isArray(record.listed)
      ? record.listed.filter((id): id is string => typeof id === "string" && Boolean(id))
      : working;
    const enabled = Array.isArray(record.enabled)
      ? record.enabled.filter((id): id is string => typeof id === "string" && working.includes(id))
      : [];
    const failed = Array.isArray(record.failed)
      ? record.failed.filter((id): id is string => typeof id === "string" && listed.includes(id) && !working.includes(id))
      : [];
    return { provider: record.provider, listed, working, enabled, failed };
  }

  private writeCache(username: string, entry: ModelCache | undefined): void {
    const all = { ...(this.context.globalState.get<Record<string, ModelCache>>(MODELS_KEY, {}) ?? {}) };
    if (entry) {
      all[username] = entry;
    } else {
      delete all[username];
    }
    void this.context.globalState.update(MODELS_KEY, all);
  }

  private async credentialFor(user: AccountRecord): Promise<UserCredential | null> {
    let saved = await this.readSaved(user.id);
    if (saved?.source === "chatgpt-plan" && saved.chatgpt) {
      saved = await this.refreshSavedChatGpt(user.id, saved);
    }
    return credentialFor(saved);
  }

  private refreshSavedChatGpt(username: string, saved: SavedCredential): Promise<SavedCredential> {
    const run = this.chatgptRefresh.then(() => this.refreshSavedChatGptNow(username, saved));
    this.chatgptRefresh = run.then(() => undefined, () => undefined);
    return run;
  }

  private async refreshSavedChatGptNow(username: string, saved: SavedCredential): Promise<SavedCredential> {
    const latest = await this.readSaved(username);
    const current = latest?.source === "chatgpt-plan" && latest.chatgpt ? latest : saved;
    const session = current.chatgpt;
    if (!session || !needsChatGptRefresh(session)) {
      return current;
    }
    const refreshed = await refreshChatGptSession(session);
    const next: SavedCredential = { ...current, source: "chatgpt-plan", provider: "openai", chatgpt: refreshed.session };
    await this.context.secrets.store(this.secretKey(username), JSON.stringify(next));
    if (refreshed.session.clientId) {
      await this.context.secrets.store(this.chatgptKey(username), JSON.stringify(refreshed.session));
    }
    return next;
  }

  private async ensureHostId(): Promise<string> {
    const existing = this.context.globalState.get<string>(HOST_ID_KEY);
    if (existing?.startsWith("urn:uuid:")) {
      return existing;
    }
    const hostId = createHostId();
    await this.context.globalState.update(HOST_ID_KEY, hostId);
    return hostId;
  }

  private async readChatGpt(username: string): Promise<ChatGptCredential | null> {
    const side = await this.readChatGptSecret(this.chatgptKey(username));
    if (side?.clientId) {
      return side;
    }
    const saved = await this.readSaved(username);
    return saved?.source === "chatgpt-plan" ? saved.chatgpt ?? null : null;
  }

  private async readChatGptSecret(key: string): Promise<ChatGptCredential | null> {
    const raw = await this.context.secrets.get(key);
    if (!raw) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as ChatGptCredential;
      if (!parsed || typeof parsed !== "object" || !parsed.clientId || !parsed.subject) {
        return null;
      }
      return { ...parsed, scopes: Array.isArray(parsed.scopes) ? parsed.scopes.filter((scope) => typeof scope === "string") : [] };
    } catch {
      return null;
    }
  }

  private chatgptKey(accountId: string): string {
    return `codecook.chatgpt.${accountId}`;
  }

  private sessionUser(): AccountRecord | undefined {
    const id = this.context.globalState.get<string>(SESSION_KEY);
    if (!id) {
      return undefined;
    }
    return this.readUsers().find((user) => user.id === id);
  }

  private readUsers(): AccountRecord[] {
    const raw = this.context.globalState.get<unknown>(USERS_KEY, []);
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw.filter((item): item is AccountRecord => {
      if (!item || typeof item !== "object") {
        return false;
      }
      const record = item as AccountRecord;
      return (record.provider === "local" || record.provider === "google" || record.provider === "github")
        && typeof record.id === "string"
        && typeof record.subject === "string"
        && typeof record.label === "string"
        && record.id === `${record.provider}:${record.subject}`;
    });
  }

  private async readSaved(username: string): Promise<SavedCredential | null> {
    const raw = await this.context.secrets.get(this.secretKey(username));
    if (!raw) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as SavedCredential;
      if (!parsed || typeof parsed !== "object" || !parsed.provider) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private secretKey(accountId: string): string {
    return `codecook.cred.${accountId}`;
  }
}
