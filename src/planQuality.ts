import type { Plan, PlanQuestion } from "./types";

export function isThinPlanMd(md: string): boolean {
  const text = String(md || "").trim();
  return text.length < 800 || !/^#{1,3}\s+/m.test(text);
}

export function mergePlanUpdate(
  existing: Plan | undefined,
  incoming: { title?: string; overview?: string; body_md?: string },
  status: Plan["status"]
): Plan | undefined {
  const title = String(incoming.title ?? "").trim() || existing?.title || "";
  const overview = String(incoming.overview ?? "").trim() || existing?.overview || "";
  const incomingBody = String(incoming.body_md ?? "").trim();
  const existingBody = existing?.body_md?.trim() || "";
  let body = existingBody;
  const shorter = Boolean(existingBody) && incomingBody.length < existingBody.length;
  if (!incomingBody || shorter) {
    body = existingBody;
  } else if (!isThinPlanMd(incomingBody)) {
    body = incomingBody;
  } else if (!existingBody || isThinPlanMd(existingBody)) {
    body = incomingBody;
  }
  if (!existing && !title && !overview && !body) {
    return undefined;
  }
  return { title, overview, body_md: body, status };
}

export function parseAskQuestions(raw: unknown): { ok: true; questions: PlanQuestion[] } | { ok: false; error: string } {
  const list = Array.isArray(raw) ? raw : (raw as { questions?: unknown })?.questions;
  if (!Array.isArray(list) || !list.length) {
    return { ok: false, error: "Error: ask_question requires a non-empty 'questions' array." };
  }
  if (list.length > 6) {
    return { ok: false, error: "Error: ask_question accepts at most 6 questions." };
  }
  const questions: PlanQuestion[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < list.length; i++) {
    const item = list[i] as Record<string, unknown>;
    if (!item || typeof item !== "object") {
      return { ok: false, error: `Error: Question ${i}: must be an object.` };
    }
    const id = String(item.id ?? "").trim();
    const prompt = String(item.prompt ?? "").trim();
    if (!id || !prompt) {
      return { ok: false, error: `Error: Question ${i}: 'id' and 'prompt' are required.` };
    }
    if (seen.has(id)) {
      return { ok: false, error: `Error: Duplicate question id '${id}'.` };
    }
    seen.add(id);
    const opts = Array.isArray(item.options) ? item.options : [];
    if (opts.length < 2 || opts.length > 6) {
      return { ok: false, error: `Error: Question '${id}' needs 2–6 options.` };
    }
    const options = [];
    const optIds = new Set<string>();
    for (const opt of opts) {
      const row = opt as Record<string, unknown>;
      const oid = String(row?.id ?? "").trim();
      const label = String(row?.label ?? "").trim();
      if (!oid || !label) {
        return { ok: false, error: `Error: Question '${id}' has an option missing id or label.` };
      }
      if (optIds.has(oid)) {
        return { ok: false, error: `Error: Question '${id}' has duplicate option '${oid}'.` };
      }
      optIds.add(oid);
      options.push({ id: oid, label });
    }
    const recommended = item.recommended != null ? String(item.recommended).trim() : undefined;
    if (recommended && !optIds.has(recommended)) {
      return { ok: false, error: `Error: Question '${id}' recommended option '${recommended}' is not in options.` };
    }
    questions.push({ id, prompt, options, recommended: recommended || undefined });
  }
  return { ok: true, questions };
}
