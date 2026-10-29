import type { ToolCall, ToolSchema } from "./types";

export interface SseEvent {
  event: string;
  data: string;
}

export function chatGptModelIds(body: Record<string, unknown>): string[] {
  const models = Array.isArray(body.models) ? body.models : [];
  const ids: string[] = [];
  for (const model of models) {
    if (!model || typeof model !== "object") {
      continue;
    }
    const item = model as { slug?: unknown; visibility?: unknown };
    if (item.visibility !== "list" || typeof item.slug !== "string" || !item.slug) {
      continue;
    }
    ids.push(item.slug);
  }
  return ids;
}

export function parseSseBlocks(buffer: string): { events: SseEvent[]; rest: string } {
  const parts = buffer.split(/\r?\n\r?\n/);
  const rest = parts.pop() ?? "";
  const events: SseEvent[] = [];
  for (const part of parts) {
    if (!part.trim()) {
      continue;
    }
    let event = "message";
    const data: string[] = [];
    for (const line of part.split(/\r?\n/)) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        data.push(line.slice(5).trimStart());
      }
    }
    if (data.length) {
      events.push({ event, data: data.join("\n") });
    }
  }
  return { events, rest };
}

export function toChatGptPlan(
  messages: Array<Record<string, unknown>>,
  tools: ToolSchema[] | undefined,
  forced: string[] | undefined,
  modelId: string
): Record<string, unknown> {
  const instructions: string[] = [];
  const input: unknown[] = [];
  if (tools?.length) {
    input.push({
      type: "additional_tools",
      role: "developer",
      tools: [
        {
          type: "namespace",
          name: "functions",
          description: "CodeCook workspace tools.",
          tools: tools.map((tool) => ({
            type: "function",
            name: tool.function.name,
            description: tool.function.description,
            parameters: tool.function.parameters,
          })),
        },
      ],
    });
  }
  for (const message of messages) {
    const role = String(message.role ?? "user");
    if (role === "system") {
      const text = String(message.content ?? "");
      if (text) {
        instructions.push(text);
      }
      continue;
    }
    if (role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: String(message.tool_call_id ?? ""),
        output: String(message.content ?? ""),
      });
      continue;
    }
    if (role === "assistant") {
      const text = String(message.content ?? "");
      if (text) {
        input.push({ role: "assistant", content: text });
      }
      for (const call of (message.tool_calls as ToolCall[] | undefined) ?? []) {
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.function?.name ?? "",
          arguments: call.function?.arguments || "{}",
        });
      }
      continue;
    }
    const text = String(message.content ?? "");
    const images = imageParts(message);
    if (!text && !images.length) {
      continue;
    }
    if (!images.length) {
      input.push({ role: "user", content: text });
      continue;
    }
    const content: unknown[] = [];
    if (text) {
      content.push({ type: "input_text", text });
    }
    content.push(...images);
    input.push({ role: "user", content });
  }
  const body: Record<string, unknown> = {
    model: modelId,
    input,
    store: false,
    stream: true,
  };
  if (instructions.length) {
    body.instructions = instructions.join("\n\n");
  }
  if (forced?.length === 1) {
    body.tool_choice = { type: "function", name: forced[0] };
  } else if (forced && forced.length > 1) {
    body.tool_choice = "required";
  }
  return body;
}

function imageParts(message: Record<string, unknown>): unknown[] {
  const images = Array.isArray(message.images) ? message.images : [];
  const parts: unknown[] = [];
  for (const image of images) {
    if (!image || typeof image !== "object") {
      continue;
    }
    const data = String((image as { data?: unknown }).data ?? "");
    const mime = String((image as { mime?: unknown }).mime ?? "image/png");
    if (data) {
      parts.push({ type: "input_image", image_url: `data:${mime};base64,${data}` });
    }
  }
  return parts;
}
