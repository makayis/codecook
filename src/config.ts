import * as vscode from "vscode";
import type { Settings } from "./types";

export const MODEL_CATALOG = [
  { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro Preview" },
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
];

export { estimateCostUsd, FLASH_MODEL, modelRates, PRO_MODEL } from "./models";

export function loadSettings(): Settings {
  const c = vscode.workspace.getConfiguration("codecook");
  return {
    gcpProject: c.get("gcpProject", ""),
    gcpLocation: c.get("gcpLocation", "global"),
    model: c.get("model", "gemini-3.1-pro-preview"),
    summaryModel: c.get("summaryModel", "gemini-2.5-flash"),
    contextTokenBudget: c.get("contextTokenBudget", 250000),
    contextTokenBudgetCeiling: c.get("contextTokenBudgetCeiling", 250000),
    contextSummarizeThreshold: c.get("contextSummarizeThreshold", 0.2),
    contextKeepRecentGroups: c.get("contextKeepRecentGroups", 6),
    contextMinCompactableTokens: c.get("contextMinCompactableTokens", 8000),
    toolResultMaxChars: c.get("toolResultMaxChars", 8000),
    summaryToolResultMaxChars: c.get("summaryToolResultMaxChars", 1200),
    contextRefMaxChars: c.get("contextRefMaxChars", 16000),
    planBodyMaxChars: c.get("planBodyMaxChars", 20000),
    llmMaxCompletionTokens: c.get("llmMaxCompletionTokens", 8192),
    turnTokenCeiling: c.get("turnTokenCeiling", 1000000),
    attachmentImageTokenCost: c.get("attachmentImageTokenCost", 1200),
    pricePromptPerMillionFlash: c.get("pricePromptPerMillionFlash", 0.15),
    priceCompletionPerMillionFlash: c.get("priceCompletionPerMillionFlash", 0.6),
    pricePromptPerMillionPro: c.get("pricePromptPerMillionPro", 1.25),
    priceCompletionPerMillionPro: c.get("priceCompletionPerMillionPro", 10),
    spendLimitDailyUsd: c.get("spendLimitDailyUsd", 0),
    spendLimitWeeklyUsd: c.get("spendLimitWeeklyUsd", 0),
    spendLimitMonthlyUsd: c.get("spendLimitMonthlyUsd", 0),
  };
}

export async function saveSpendLimits(daily: number, weekly: number, monthly: number): Promise<void> {
  const c = vscode.workspace.getConfiguration("codecook");
  const target = vscode.ConfigurationTarget.Global;
  await c.update("spendLimitDailyUsd", daily, target);
  await c.update("spendLimitWeeklyUsd", weekly, target);
  await c.update("spendLimitMonthlyUsd", monthly, target);
}
