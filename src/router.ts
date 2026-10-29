import { fastModel, isGeminiId, pickListedModel, strongModel } from "./providers";
import type { Mode, ProviderId, TaskType, ToolCall } from "./types";

const COMPLEX =
  /\b(implement|refactor|fix|generate|create|build|write|edit|plan|migrate|rewrite|debug)\b/i;

export function stripContext(text: string): string {
  return String(text || "")
    .replace(/--- Context file:[\s\S]*?--- End context file ---\n*/g, "")
    .trim();
}

export function routeModel(
  mode: Mode,
  userText: string,
  selected?: string,
  provider: ProviderId = "google",
  available?: string[]
): { model: string; automatic: boolean; reason: string } {
  if (selected && selected !== "auto" && (provider === "google" || !isGeminiId(selected))) {
    return { model: selected, automatic: false, reason: "Selected model" };
  }
  const text = stripContext(userText);
  const complexMode = mode === "plan" || mode === "agent";
  const long = text.length > 280;
  const verbs = COMPLEX.test(text);
  if (complexMode || long || verbs) {
    const model = pickListedModel(strongModel(provider), available, "strong");
    return {
      model,
      automatic: true,
      reason: provider === "google" ? "Auto-routed to Pro for a complex task" : `Auto-routed to ${model} for a complex task`,
    };
  }
  const model = pickListedModel(fastModel(provider), available, "fast");
  return {
    model,
    automatic: true,
    reason: provider === "google" ? "Auto-routed to Flash for a simple question" : `Auto-routed to ${model} for a simple question`,
  };
}

export function taskTypeFrom(mode: Mode, calls: ToolCall[]): TaskType {
  if (mode === "chat") {
    return "chat";
  }
  if (mode === "plan") {
    return "plan";
  }
  const names = calls.map((c) => c.function?.name ?? "");
  if (names.includes("write_file")) {
    return "generate";
  }
  if (names.includes("edit_file")) {
    return "refactor";
  }
  return "agent";
}
