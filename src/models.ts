import type { Settings } from "./types";

export const FLASH_MODEL = "gemini-2.5-flash";
export const PRO_MODEL = "gemini-3.1-pro-preview";

type Rates = Pick<
  Settings,
  | "pricePromptPerMillionFlash"
  | "priceCompletionPerMillionFlash"
  | "pricePromptPerMillionPro"
  | "priceCompletionPerMillionPro"
>;

export function modelRates(settings: Rates, model: string): { prompt: number; completion: number } {
  const id = model.toLowerCase();
  if (id.includes("gemini")) {
    if (id.includes("flash")) {
      return { prompt: settings.pricePromptPerMillionFlash, completion: settings.priceCompletionPerMillionFlash };
    }
    return { prompt: settings.pricePromptPerMillionPro, completion: settings.priceCompletionPerMillionPro };
  }
  if (id.includes("haiku") || id.includes("mini") || id.includes("nova")) {
    return { prompt: 0.8, completion: 4 };
  }
  if (id.includes("claude") || id.includes("anthropic")) {
    return { prompt: 3, completion: 15 };
  }
  if (id.startsWith("gpt") || id.startsWith("o1") || id.startsWith("o3")) {
    return { prompt: 2, completion: 8 };
  }
  return { prompt: settings.pricePromptPerMillionPro, completion: settings.priceCompletionPerMillionPro };
}

export function estimateCostUsd(settings: Rates, model: string, prompt: number, completion: number): number {
  const rates = modelRates(settings, model);
  return (Math.max(0, prompt) * rates.prompt + Math.max(0, completion) * rates.completion) / 1_000_000;
}

function cacheInputRatio(model: string): number {
  const id = model.toLowerCase();
  if (id.includes("gemini")) {
    return id.includes("flash") ? 0.25 : 0.1;
  }
  if (id.includes("claude") || id.includes("anthropic")) {
    return 0.1;
  }
  if (id.startsWith("gpt") || id.startsWith("o1") || id.startsWith("o3") || id.startsWith("o4")) {
    return 0.5;
  }
  return 1;
}

export function estimateDisplayCostUsd(
  settings: Rates,
  model: string,
  prompt: number,
  completion: number,
  cached = 0
): number {
  const rates = modelRates(settings, model);
  const promptTokens = Math.max(0, prompt);
  const cachedTokens = Math.min(promptTokens, Math.max(0, cached));
  const ratio = cacheInputRatio(model);
  const fresh = promptTokens - cachedTokens;
  return (
    (fresh * rates.prompt + cachedTokens * rates.prompt * ratio + Math.max(0, completion) * rates.completion) /
    1_000_000
  );
}

export function cacheDiscountUsd(settings: Rates, model: string, cached: number, prompt?: number): number {
  const rates = modelRates(settings, model);
  const ratio = cacheInputRatio(model);
  const cap = prompt == null ? Math.max(0, cached) : Math.min(Math.max(0, cached), Math.max(0, prompt));
  return (cap * rates.prompt * (1 - ratio)) / 1_000_000;
}

export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount)) {
    return "$0.00";
  }
  const sign = amount < 0 ? "-" : "";
  const value = Math.abs(amount);
  if (value === 0) {
    return "$0.00";
  }
  if (value >= 1 && Math.abs(value - Math.round(value)) < 1e-9) {
    return `${sign}$${Math.round(value)}`;
  }
  if (value >= 0.01) {
    return `${sign}$${value.toFixed(2)}`;
  }
  const four = value.toFixed(4);
  if (four === "0.0000") {
    return `${sign}<$0.0001`;
  }
  return `${sign}$${four}`;
}
