import { modelCanReadImages } from "./attachments";
import type { ProviderId, Settings } from "./types";

export interface ModelChoice {
  id: string;
  label: string;
}

const GOOGLE_MODELS: ModelChoice[] = [
  { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro Preview" },
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
];

const OPENAI_MODELS: ModelChoice[] = [
  { id: "gpt-4.1", label: "GPT-4.1" },
  { id: "gpt-4.1-mini", label: "GPT-4.1 mini" },
  { id: "gpt-4o", label: "GPT-4o" },
];

const ANTHROPIC_MODELS: ModelChoice[] = [
  { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
];

const AWS_MODELS: ModelChoice[] = [
  { id: "anthropic.claude-3-5-sonnet-20241022-v2:0", label: "Claude 3.5 Sonnet" },
  { id: "anthropic.claude-3-5-haiku-20241022-v1:0", label: "Claude 3.5 Haiku" },
];

const CATALOGS: Record<ProviderId, ModelChoice[]> = {
  google: GOOGLE_MODELS,
  openai: OPENAI_MODELS,
  anthropic: ANTHROPIC_MODELS,
  azure: OPENAI_MODELS,
  aws: AWS_MODELS,
};

const STRONG: Record<ProviderId, string> = {
  google: "gemini-3.1-pro-preview",
  openai: "gpt-4.1",
  anthropic: "claude-sonnet-4-5",
  azure: "gpt-4.1",
  aws: "anthropic.claude-3-5-sonnet-20241022-v2:0",
};

const FAST: Record<ProviderId, string> = {
  google: "gemini-2.5-flash",
  openai: "gpt-4.1-mini",
  anthropic: "claude-haiku-4-5",
  azure: "gpt-4.1-mini",
  aws: "anthropic.claude-3-5-haiku-20241022-v1:0",
};

export function catalogFor(provider: ProviderId, custom?: string): ModelChoice[] {
  const base = CATALOGS[provider];
  if (custom && !base.some((item) => item.id === custom)) {
    return [...base, { id: custom, label: custom }];
  }
  return base;
}

const NON_CHAT = /embed|whisper|tts|dall-e|moderation|transcribe|realtime|audio|image|stable-diffusion|imagen|deep-research|gpt-live|babbage|davinci|^sora([.-]|$)/i;

export function selectChatModels(provider: ProviderId, ids: string[]): ModelChoice[] {
  const cleaned = [...new Set(ids.map((id) => id.replace(/^models\//, "").trim()).filter(Boolean))];
  const kept = cleaned.filter((id) => {
    if (NON_CHAT.test(id)) {
      return false;
    }
    const lower = id.toLowerCase();
    if (provider === "anthropic") {
      return lower.includes("claude");
    }
    if (provider === "google") {
      return lower.includes("gemini");
    }
    return true;
  });
  kept.sort((a, b) => a.localeCompare(b));
  return kept.map((id) => ({ id, label: id }));
}

export function enabledModels(working: string[], selected: string[]): string[] {
  const allow = new Set(working);
  return selected.filter((id) => allow.has(id));
}

export function supportsReasoning(modelId: string): boolean {
  const id = modelId.toLowerCase();
  if (/^o\d/.test(id)) {
    return true;
  }
  const major = /^gpt-(\d+)/.exec(id);
  return Boolean(major && Number(major[1]) >= 5);
}

export function reasoningEffort(modelId: string, choice?: string): "none" | "low" | "medium" | "high" | undefined {
  if (!supportsReasoning(modelId)) {
    return undefined;
  }
  const level = String(choice ?? "").toLowerCase();
  if (level === "off" || level === "none") {
    return "none";
  }
  if (level === "low" || level === "medium" || level === "high") {
    return level;
  }
  return "low";
}

export function pickListedModel(preferred: string, available: string[] | undefined, kind: "fast" | "strong"): string {
  if (!available?.length) {
    return preferred;
  }
  if (available.includes(preferred)) {
    return preferred;
  }
  const fastish = (id: string) => /mini|haiku|flash|nano/i.test(id);
  if (kind === "fast") {
    return available.find(fastish) ?? available[available.length - 1];
  }
  return available.find((id) => !fastish(id)) ?? available[0];
}

export function strongModel(provider: ProviderId): string {
  return STRONG[provider];
}

export function fastModel(provider: ProviderId): string {
  return FAST[provider];
}

const SUMMARY_PREFERENCE: Record<ProviderId, string[]> = {
  google: ["gemini-2.5-flash", "gemini-3.8-flash"],
  openai: ["gpt-4.1-mini"],
  anthropic: ["claude-haiku-4-5"],
  azure: ["gpt-4.1-mini"],
  aws: ["anthropic.claude-3-5-haiku-20241022-v1:0"],
};

const SMALL_EXCLUDE = new Set(["pro", "opus", "sonnet", "ultra"]);
const FOLD_CONTEXT_FLOOR = 8000;

export function summaryModelFor(
  settings: Settings,
  provider: ProviderId,
  available?: string[],
  chatModel?: string,
  contextLimits?: Record<string, number>
): { id: string; reason: string } {
  const enabled = (available ?? []).map((id) => id.trim()).filter(Boolean);
  const hasList = enabled.length > 0;
  const fits = (id: string) => {
    const limit = contextLimits?.[id];
    return !(typeof limit === "number" && limit > 0 && limit < FOLD_CONTEXT_FLOOR);
  };
  if (settings.summaryModel && hasList && enabled.includes(settings.summaryModel) && fits(settings.summaryModel)) {
    return { id: settings.summaryModel, reason: "setting" };
  }
  for (const preferred of SUMMARY_PREFERENCE[provider]) {
    const exact = hasList ? enabled.find((id) => id === preferred && fits(id)) : fits(preferred) ? preferred : undefined;
    if (exact) {
      return { id: exact, reason: "preferred" };
    }
    const prefixed = enabled.find((id) => id !== preferred && (id.startsWith(`${preferred}-`) || id.startsWith(`${preferred}.`)) && smallRank(id) >= 0 && fits(id));
    if (prefixed) {
      return { id: prefixed, reason: "preferred" };
    }
  }
  const ranked = enabled
    .map((id) => ({ id, rank: smallRank(id) }))
    .filter((item) => item.rank >= 0 && fits(item.id))
    .sort((a, b) => a.rank - b.rank || versionScore(b.id) - versionScore(a.id) || Number(unstable(a.id)) - Number(unstable(b.id)));
  if (ranked[0]) {
    return { id: ranked[0].id, reason: "ranked" };
  }
  const fallback = chatModel || settings.model || enabled[0] || SUMMARY_PREFERENCE[provider][0];
  return { id: fallback, reason: "fallback-chat-model" };
}

export function smallRank(id: string): number {
  const parts = id.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (parts.some((part) => SMALL_EXCLUDE.has(part))) {
    return -1;
  }
  if (parts.includes("lite") || parts.includes("nano")) {
    return 2;
  }
  if (parts.includes("mini")) {
    return 1;
  }
  if (parts.includes("flash") || parts.includes("haiku")) {
    return 0;
  }
  return -1;
}

function versionScore(id: string): number {
  const nums = id.match(/\d+/g)?.map((part) => Number(part)) ?? [];
  return nums.reduce((total, value) => total * 1000 + value, 0);
}

function unstable(id: string): boolean {
  const parts = id.toLowerCase().split(/[^a-z0-9]+/);
  return parts.includes("preview") || parts.includes("exp");
}

export function visionModels(provider: ProviderId, available?: string[]): string[] {
  if (available) {
    if (provider === "google") {
      return available.filter((id) => modelCanReadImages(id));
    }
    return available.length ? [pickListedModel(fastModel(provider), available, "fast")] : [];
  }
  if (provider === "google") {
    return ["gemini-3.8-flash", "gemini-2.5-flash"];
  }
  return [fastModel(provider)];
}

export function isGeminiId(model: string): boolean {
  return model.toLowerCase().includes("gemini");
}
