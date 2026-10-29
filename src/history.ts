import { middleTruncate } from "./text";
import { SUMMARIZER_SYSTEM_PROMPT } from "./prompts";
import type { Message, Plan, Settings, Todo, ToolCall, ToolSchema } from "./types";

export const OPENING_MESSAGE_MAX_CHARS = 8000;
export const MEMORY_TARGET_TOKENS = 4000;
export const MEMORY_HEADINGS = [
  "GOAL",
  "USER_REQUIREMENTS",
  "DECISIONS",
  "FILES",
  "IMPORTANT_IDENTIFIERS",
  "RUNNING_COMMANDS",
  "KNOWN_FAILURES_DO_NOT_REPEAT",
  "OPEN_WORK",
] as const;

const OMITTED_TOOL_FIELDS = new Set(["content", "old_string", "new_string", "plan_md", "edits", "todos"]);

export const INTERRUPTED_PLACEHOLDER =
  "This tool call was interrupted before a result was recorded " +
  "(the turn was cancelled). The outcome is unknown; re-run it if you still need it.";

export function estimateTokens(
  messages: Array<Record<string, unknown>>,
  toolSchemas?: ToolSchema[],
  imageTokenCost = 1200
): number {
  let totalChars = 0;
  let imageCount = 0;

  for (const msg of messages) {
    const content = msg.content;
    if (typeof content === "string") {
      totalChars += content.length;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part === "object") {
          if (part.type === "text") {
            totalChars += String(part.text ?? "").length;
          } else if (part.type === "image_url") {
            imageCount += 1;
          }
        } else if (typeof part === "string") {
          totalChars += part.length;
        }
      }
    }
    if (msg.tool_calls) {
      totalChars += JSON.stringify(msg.tool_calls).length;
    }
    if (msg.tool_call_id) {
      totalChars += String(msg.tool_call_id).length;
    }
    if (Array.isArray(msg.images)) {
      imageCount += msg.images.length;
    } else if (Array.isArray(msg.attachments)) {
      imageCount += (msg.attachments as Array<{ kind?: string }>).filter((file) => file?.kind === "image").length;
    }
  }
  if (toolSchemas) {
    totalChars += JSON.stringify(toolSchemas).length;
  }
  return Math.floor(totalChars / 4) + messages.length * 4 + imageCount * imageTokenCost;
}

export function groupMessages(messages: Array<Record<string, unknown>>): Array<Array<Record<string, unknown>>> {
  const groups: Array<Array<Record<string, unknown>>> = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      const group = [msg];
      let j = i + 1;
      while (j < messages.length && messages[j].role === "tool") {
        group.push(messages[j]);
        j += 1;
      }
      groups.push(group);
      i = j;
    } else {
      groups.push([msg]);
      i += 1;
    }
  }
  return groups;
}

export function projectMessages(
  messages: Message[],
  maxToolResultChars: number
): Array<Record<string, unknown>> {
  const projected: Array<Record<string, unknown>> = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      const proj: Record<string, unknown> = {
        role: "assistant",
        content: msg.content || "",
      };
      if (msg.tool_calls?.length) {
        proj.tool_calls = msg.tool_calls.map((tc) => {
          const call: ToolCall = {
            id: tc.id,
            type: "function",
            function: {
              name: tc.function?.name ?? "",
              arguments: tc.function?.arguments ?? "{}",
            },
          };
          if (tc.thought_signature) {
            call.thought_signature = tc.thought_signature;
          }
          return call;
        });
      }
      projected.push(proj);
    } else if (msg.role === "tool") {
      const content =
        msg.content == null ? INTERRUPTED_PLACEHOLDER : middleTruncate(String(msg.content), maxToolResultChars);
      projected.push({
        role: "tool",
        content,
        tool_call_id: msg.tool_call_id ?? "",
      });
    } else {
      const proj: Record<string, unknown> = { role: msg.role, content: msg.content ?? "" };
      if (msg.attachments?.length) {
        proj.attachments = msg.attachments;
      }
      projected.push(proj);
    }
  }
  return projected;
}

export function fitGroups(
  groups: Array<Array<Record<string, unknown>>>,
  budget: number,
  systemTokens = 0,
  summaryTokens = 0,
  planTokens = 0,
  toolSchemaTokens = 0
): { fitted: Array<Array<Record<string, unknown>>>; elided: number } {
  const available = budget - systemTokens - summaryTokens - planTokens - toolSchemaTokens;
  const allMsgs = groups.flat();
  if (estimateTokens(allMsgs) <= available || groups.length <= 1) {
    return { fitted: groups, elided: 0 };
  }

  const first = groups[0];
  const remaining = groups.slice(1);
  const kept = [first];
  let used = estimateTokens(first);
  const addedFromEnd: Array<Array<Record<string, unknown>>> = [];

  for (let i = remaining.length - 1; i >= 0; i--) {
    const g = remaining[i];
    const gTokens = estimateTokens(g);
    if (used + gTokens <= available) {
      addedFromEnd.push(g);
      used += gTokens;
    } else {
      break;
    }
  }

  if (!addedFromEnd.length && remaining.length) {
    addedFromEnd.push(remaining[remaining.length - 1]);
  }
  addedFromEnd.reverse();
  return { fitted: kept.concat(addedFromEnd), elided: remaining.length - addedFromEnd.length };
}

export function buildPlanBlock(plan?: Plan, todos?: Todo[]): string | undefined {
  if (!plan && (!todos || !todos.length)) {
    return undefined;
  }
  const parts = ["<current_plan>"];
  if (plan) {
    if (plan.title) {
      parts.push(`# ${plan.title}`);
    }
    if (plan.overview) {
      parts.push(`**Overview:** ${plan.overview}`);
    }
    if (plan.body_md) {
      parts.push(plan.body_md);
    }
  }
  if (todos?.length) {
    parts.push("## Current Tasks");
    parts.push("```json");
    parts.push(JSON.stringify(todos, null, 2));
    parts.push("```");
  }
  parts.push("</current_plan>");
  return parts.join("\n\n");
}

export function shouldSummarize(
  messages: Message[],
  budget: number,
  summary: { through_seq?: number; summary_text?: string } | undefined,
  _alreadySummarizedThisTurn: boolean,
  settings: Settings,
  toolSchemas?: ToolSchema[]
): boolean {
  return compactionPlan(messages, summary, settings, toolSchemas, false).summarizeMessages.length > 0;
}

export function compactionPlan(
  messages: Message[],
  summary: { through_seq?: number; summary_text?: string } | undefined,
  settings: Pick<Settings, "contextTokenBudget" | "contextSummarizeThreshold" | "contextKeepRecentGroups" | "attachmentImageTokenCost"> &
    Partial<Pick<Settings, "contextMinCompactableTokens" | "llmMaxCompletionTokens">>,
  toolSchemas?: ToolSchema[],
  force = false,
  overheadTokens = 0
): { promptMessages: Message[]; summarizeMessages: Message[]; throughSeq: number | null } {
  const usable = messages.filter((message) => !message.notice);
  const groups = groupMessages(usable as unknown as Array<Record<string, unknown>>) as unknown as Message[][];
  if (!groups.length) {
    return { promptMessages: [], summarizeMessages: [], throughSeq: null };
  }
  const maxSeq = Math.max(...usable.map((message) => message.seq));
  const through = summary?.through_seq ?? -1;
  const canDrop = through >= 0 && through < maxSeq;
  const visible = canDrop
    ? groups.filter((group, index) => index === 0 || groupEnd(group) > through)
    : groups;
  const summaryTokens = summary?.summary_text
    ? estimateTokens([{ role: "user", content: summary.summary_text }])
    : 0;
  const schemaTokens = toolSchemas ? estimateTokens([], toolSchemas, settings.attachmentImageTokenCost) : 0;
  const trigger = settings.contextTokenBudget * settings.contextSummarizeThreshold;
  const reserve = settings.llmMaxCompletionTokens ?? 0;
  const hardLimit = Math.max(1, settings.contextTokenBudget - reserve);
  const minFold = settings.contextMinCompactableTokens ?? 8000;
  const size = (selected: Message[][]) =>
    estimateTokens(selected.flat() as unknown as Array<Record<string, unknown>>, undefined, settings.attachmentImageTokenCost) +
    summaryTokens +
    schemaTokens +
    overheadTokens;

  const first = visible[0];
  let keep = Math.min(Math.max(settings.contextKeepRecentGroups, 1), visible.length);
  const select = (keepCount: number) => {
    const recent = visible.slice(-keepCount);
    const recentSeqs = new Set(recent.flat().map((message) => message.seq));
    const kept = recentSeqs.has(first[0].seq) ? recent : [first, ...recent];
    const older = visible.filter((group) => !kept.includes(group));
    return { kept, older };
  };
  let selected = select(keep);
  while (keep > 1 && size(selected.kept) >= hardLimit) {
    keep -= 1;
    selected = select(keep);
  }
  const older = selected.older;
  if (!older.length) {
    return { promptMessages: visible.flat(), summarizeMessages: [], throughSeq: null };
  }
  const foldableTokens = estimateTokens(
    older.flat() as unknown as Array<Record<string, unknown>>,
    undefined,
    settings.attachmentImageTokenCost
  );
  if ((!force && size(visible) < trigger) || foldableTokens < minFold) {
    return { promptMessages: visible.flat(), summarizeMessages: [], throughSeq: null };
  }
  return {
    promptMessages: selected.kept.flat(),
    summarizeMessages: older.flat(),
    throughSeq: Math.max(...older.flat().map((message) => message.seq)),
  };
}

export function truncateOpeningMessage(messages: Message[]): Message[] {
  if (!messages.length) {
    return messages;
  }
  const content = messages[0].content ?? "";
  if (content.length <= OPENING_MESSAGE_MAX_CHARS) {
    return messages;
  }
  return [{ ...messages[0], content: middleTruncate(content, OPENING_MESSAGE_MAX_CHARS) }, ...messages.slice(1)];
}

function groupEnd(group: Message[]): number {
  return Math.max(...group.map((message) => message.seq));
}

export function historyTokenCounts(
  stored: Message[],
  sentMessages: Array<Record<string, unknown>>,
  imageTokenCost = 1200
): { historyFull: number; historySent: number; userTokens: number } {
  const real = stored.filter((message) => !message.notice);
  const historyFull = estimateTokens(messageRecords(real), undefined, imageTokenCost);
  const historySent = estimateTokens(sentMessages, undefined, imageTokenCost);
  const latest = [...real].reverse().find((message) => message.role === "user" && !message.hidden);
  const userTokens = latest ? estimateTokens([{ role: "user", content: latest.content ?? "" }]) : 0;
  return { historyFull, historySent, userTokens };
}

export function buildSummarizerInput(
  messages: Message[],
  priorSummary: string | undefined,
  priorCount: number,
  maxToolChars: number,
  maxNarrativeChars = 16000
): Array<Record<string, unknown>> {
  const visible = messages.filter((message) => !message.hidden);
  const groups = groupMessages(visible as unknown as Array<Record<string, unknown>>);
  const parts: string[] = [];
  if (priorSummary) {
    parts.push(`=== PRIOR CONVERSATION SUMMARY (Iteration ${priorCount}) ===`);
    parts.push(priorSummary);
    parts.push("");
    parts.push("=== NEW CONVERSATION TURNS TO FOLD INTO SUMMARY ===");
  } else {
    parts.push("=== CONVERSATION TURNS TO SUMMARIZE ===");
  }
  groups.forEach((group, i) => {
    parts.push(`--- Group ${i + 1} ---`);
    for (const msg of group) {
      const role = String(msg.role ?? "user");
      if (role === "tool") {
        const content = middleTruncate(String(msg.content ?? ""), maxToolChars);
        parts.push(`[tool_result ${msg.tool_call_id ?? ""}]: ${content}`);
      } else if (role === "assistant") {
        const calls = msg.tool_calls as ToolCall[] | undefined;
        if (calls?.length) {
          const preview = calls.map((call) => toolCallPreview(call, maxToolChars)).join("; ");
          parts.push(`[assistant tool_calls: ${preview}]`);
        }
        const content = middleTruncate(String(msg.content ?? ""), maxNarrativeChars);
        if (content) {
          parts.push(`[assistant]: ${content}`);
        }
      } else {
        const content = middleTruncate(String(msg.content ?? ""), maxNarrativeChars);
        if (content) {
          parts.push(`[${role}]: ${content}`);
        }
      }
    }
  });
  return [
    { role: "system", content: SUMMARIZER_SYSTEM_PROMPT },
    { role: "user", content: parts.join("\n") },
  ];
}

export function memoryAcceptable(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed === "Summary of earlier conversation.") {
    return false;
  }
  return MEMORY_HEADINGS.every((heading) => trimmed.split("\n").some((line) => headingName(line, heading)));
}

export function trimMemory(text: string): string {
  const sections = parseMemorySections(text);
  const render = () => {
    const body = sections.map((section) => `${section.heading}\n${section.body.trim()}`).join("\n\n");
    return `<conversation_memory>\n${body}\n</conversation_memory>`;
  };
  const tokens = () => estimateTokens([{ role: "user", content: render() }]);
  if (tokens() <= MEMORY_TARGET_TOKENS) {
    return render();
  }
  const protectedHeadings = new Set(["GOAL", "USER_REQUIREMENTS"]);
  for (let i = sections.length - 1; i >= 0 && tokens() > MEMORY_TARGET_TOKENS; i--) {
    if (protectedHeadings.has(sections[i].heading)) {
      continue;
    }
    const lines = sections[i].body.split("\n");
    while (lines.length > 0 && tokens() > MEMORY_TARGET_TOKENS) {
      lines.pop();
      sections[i] = { heading: sections[i].heading, body: lines.join("\n") };
    }
  }
  return render();
}

export function wrapMemory(text: string, elided = 0): string {
  const body = text.includes("<conversation_memory>") ? text.trim() : `<conversation_memory>\n${text.trim()}\n</conversation_memory>`;
  const note = "Earlier conversation memory. This is not a new user request.";
  const elision = elided > 0 ? `\n\n[Note: ${elided} earlier message groups were elided to fit within context limits.]` : "";
  return `${note}${elision}\n\n${body}`;
}

function toolCallPreview(call: ToolCall, maxToolChars: number): string {
  const name = call.function?.name ?? "tool";
  let parsed: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(call.function?.arguments ?? "{}") as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      parsed = raw as Record<string, unknown>;
    }
  } catch {
    return `${name}(${middleTruncate(call.function?.arguments ?? "", maxToolChars)})`;
  }
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (OMITTED_TOOL_FIELDS.has(key) || value == null) {
      continue;
    }
    if (typeof value === "string") {
      kept[key] = value;
    } else if (typeof value !== "object") {
      kept[key] = value;
    }
  }
  return `${name}(${JSON.stringify(kept)})`;
}

function parseMemorySections(text: string): Array<{ heading: string; body: string }> {
  const lines = text.replace(/<\/?conversation_memory>/g, "").split("\n");
  const sections: Array<{ heading: string; body: string }> = [];
  let current: { heading: string; body: string } | undefined;
  for (const line of lines) {
    const heading = MEMORY_HEADINGS.find((name) => headingName(line, name));
    if (heading) {
      if (current) {
        sections.push(current);
      }
      current = { heading, body: "" };
    } else if (current) {
      current.body += `${current.body ? "\n" : ""}${line}`;
    }
  }
  if (current) {
    sections.push(current);
  }
  for (const heading of MEMORY_HEADINGS) {
    if (!sections.some((section) => section.heading === heading)) {
      sections.push({ heading, body: "" });
    }
  }
  return MEMORY_HEADINGS.map((heading) => sections.find((section) => section.heading === heading) ?? { heading, body: "" });
}

function headingName(line: string, heading: string): boolean {
  const cleaned = line.trim().replace(/^#+\s*/, "").replace(/^\*\*|\*\*$/g, "").replace(/:$/, "").trim();
  return cleaned === heading;
}

function messageRecords(messages: Message[]): Array<Record<string, unknown>> {
  return messages.map((message) => ({
    role: message.role,
    content: message.content ?? "",
    tool_calls: message.tool_calls,
    tool_call_id: message.tool_call_id,
    attachments: message.attachments,
  }));
}
