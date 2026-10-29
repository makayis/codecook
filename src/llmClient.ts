import { createHash, createHmac } from "crypto";
import { randomUUID } from "crypto";
import { parseSseBlocks, toChatGptPlan } from "./chatgptPlan";
import type { LlmClient, LlmEvent, Settings, ToolCall, ToolSchema, UserCredential } from "./types";
import { VertexLlmClient } from "./llm";
import { readProviderUsage } from "./providerUsage";
import { reasoningEffort } from "./providers";

export function createLlmClient(settings: Settings, credential: UserCredential): LlmClient {
  if (credential.provider === "google") {
    return new VertexLlmClient(settings, credential);
  }
  return new FetchLlmClient(settings, credential);
}

class FetchLlmClient implements LlmClient {
  constructor(
    private settings: Settings,
    private credential: UserCredential
  ) {}

  async *streamChat(
    messages: Array<Record<string, unknown>>,
    tools: ToolSchema[] | undefined,
    model: string,
    signal?: AbortSignal,
    _thinking?: string,
    forcedToolNames?: string[]
  ): AsyncGenerator<LlmEvent> {
    const modelId = model || this.credential.model || this.settings.model;
    const effort = reasoningEffort(modelId, _thinking);
    if (signal?.aborted) {
      yield { type: "error", error: "Cancelled", model: modelId };
      return;
    }
    yield { type: "status", message: "Thinking…" };
    if (this.credential.source === "chatgpt-plan") {
      yield* this.streamChatGptPlan(messages, tools, modelId, forcedToolNames, signal);
      return;
    }
    try {
      let response = await this.request(messages, tools, modelId, forcedToolNames, signal, effort);
      let provider: string = this.credential.provider;
      if (provider === "openai" && prefersResponses(modelId)) {
        provider = "openai-responses";
      }
      if (!response.ok && provider === "openai") {
        const errText = await response.text();
        if (response.status === 404 && /not a chat model/i.test(errText)) {
          response = await this.responsesRequest(messages, tools, modelId, forcedToolNames, signal, effort ?? "low");
          provider = "openai-responses";
        } else {
          yield { type: "error", error: `LLM API error: HTTP ${response.status}: ${redact(errText.slice(0, 800), this.credential.apiKey)}`, model: modelId };
          return;
        }
      }
      if (!response.ok && provider === "openai-responses") {
        const errText = await response.text();
        if (response.status === 400 && /reasoning/i.test(errText) && effort !== "low") {
          response = await this.responsesRequest(messages, tools, modelId, forcedToolNames, signal, "low");
        } else {
          yield { type: "error", error: `LLM API error: HTTP ${response.status}: ${redact(errText.slice(0, 800), this.credential.apiKey)}`, model: modelId };
          return;
        }
      }
      if (!response.ok) {
        const errText = await response.text();
        yield { type: "error", error: `LLM API error: HTTP ${response.status}: ${redact(errText.slice(0, 800), this.credential.apiKey)}`, model: modelId };
        return;
      }
      const body = (await response.json()) as Record<string, unknown>;
      const parsed = parseProviderResponse(provider, body);
      if (parsed.error) {
        yield { type: "error", error: `LLM API error: ${redact(parsed.error, this.credential.apiKey)}`, model: modelId };
        return;
      }
      if (parsed.text) {
        yield { type: "content_delta", text: parsed.text };
      }
      if (parsed.usage.total_tokens) {
        yield { type: "usage", ...parsed.usage };
      }
      if (parsed.calls.length) {
        yield { type: "tool_calls", calls: parsed.calls };
      }
      yield {
        type: "done",
        text: parsed.text,
        tool_calls: parsed.calls,
        usage: parsed.usage,
        finish_reason: parsed.calls.length ? "tool_calls" : "stop",
      };
    } catch (err) {
      if (signal?.aborted) {
        yield { type: "error", error: "Cancelled", model: modelId };
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      yield { type: "error", error: `LLM API error: ${redact(message, this.credential.apiKey)}`, model: modelId };
    }
  }

  private async *streamChatGptPlan(
    messages: Array<Record<string, unknown>>,
    tools: ToolSchema[] | undefined,
    modelId: string,
    forcedToolNames: string[] | undefined,
    signal?: AbortSignal
  ): AsyncGenerator<LlmEvent> {
    const token = this.credential.apiKey || "";
    try {
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(toChatGptPlan(messages, tools, forcedToolNames, modelId)),
        signal,
      });
      if (!response.ok) {
        const errText = await response.text();
        yield { type: "error", error: `LLM API error: HTTP ${response.status}: ${redact(errText.slice(0, 800), token)}`, model: modelId };
        return;
      }
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("text/event-stream")) {
        const body = (await response.json()) as Record<string, unknown>;
        if (body.status !== "completed") {
          yield { type: "error", error: "The ChatGPT response ended before it completed.", model: modelId };
          return;
        }
        yield* this.emitParsed(modelId, body, token);
        return;
      }
      if (!response.body) {
        yield { type: "error", error: "The ChatGPT response ended before it completed.", model: modelId };
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let rest = "";
      let completed: Record<string, unknown> | undefined;
      let failed = "";
      const take = (block: string) => {
        const parsed = parseSseBlocks(block);
        rest = parsed.rest;
        for (const evt of parsed.events) {
          if (evt.data === "[DONE]") {
            continue;
          }
          let json: Record<string, unknown>;
          try {
            json = JSON.parse(evt.data) as Record<string, unknown>;
          } catch {
            continue;
          }
          const type = evt.event !== "message" ? evt.event : String(json.type ?? "");
          if (type === "response.failed" || type === "response.incomplete") {
            failed = chatGptStreamError(json) || failed || "The ChatGPT response ended before it completed.";
          }
          if (type === "response.completed") {
            const payload = json.response;
            completed = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : json;
          }
        }
      };
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        rest += decoder.decode(chunk.value, { stream: true });
        take(rest);
      }
      if (rest.trim()) {
        take(`${rest}\n\n`);
      }
      if (!completed || failed || completed.status === "failed" || completed.status === "incomplete") {
        yield { type: "error", error: failed || "The ChatGPT response ended before it completed.", model: modelId };
        return;
      }
      yield* this.emitParsed(modelId, completed, token);
    } catch (err) {
      if (signal?.aborted) {
        yield { type: "error", error: "Cancelled", model: modelId };
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      yield { type: "error", error: `LLM API error: ${redact(message, token)}`, model: modelId };
    }
  }

  private *emitParsed(modelId: string, body: Record<string, unknown>, token: string): Generator<LlmEvent> {
    const parsed = parseProviderResponse("openai-responses", body);
    if (parsed.error) {
      yield { type: "error", error: `LLM API error: ${redact(parsed.error, token)}`, model: modelId };
      return;
    }
    if (parsed.usage.total_tokens) {
      yield { type: "usage", ...parsed.usage };
    }
    if (parsed.calls.length) {
      yield { type: "tool_calls", calls: parsed.calls };
    }
    yield {
      type: "done",
      text: parsed.text,
      tool_calls: parsed.calls,
      usage: parsed.usage,
      finish_reason: parsed.calls.length ? "tool_calls" : "stop",
    };
  }

  private async request(
    messages: Array<Record<string, unknown>>,
    tools: ToolSchema[] | undefined,
    modelId: string,
    forcedToolNames: string[] | undefined,
    signal?: AbortSignal,
    effort?: "none" | "low" | "medium" | "high"
  ): Promise<Response> {
    if (this.credential.provider === "anthropic") {
      const converted = toAnthropic(messages, tools, forcedToolNames, this.settings.llmMaxCompletionTokens, modelId);
      return fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.credential.apiKey || "",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(converted),
        signal,
      });
    }
    if (this.credential.provider === "aws") {
      const region = this.credential.awsRegion || "us-east-1";
      const url = new URL(`https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(modelId)}/converse`);
      const body = JSON.stringify(toBedrock(messages, tools, forcedToolNames, this.settings.llmMaxCompletionTokens));
      const headers = signAws({
        method: "POST",
        url,
        body,
        accessKeyId: this.credential.apiKey || "",
        secretAccessKey: this.credential.awsSecret || "",
        region,
        service: "bedrock",
      });
      return fetch(url, { method: "POST", headers, body, signal });
    }
    if (this.credential.provider === "openai" && prefersResponses(modelId)) {
      return this.responsesRequest(messages, tools, modelId, forcedToolNames, signal, effort ?? "low");
    }
    const openaiBody = toOpenAi(messages, tools, forcedToolNames, this.settings.llmMaxCompletionTokens, modelId);
    if (this.credential.provider === "azure") {
      const endpoint = this.credential.azureEndpoint || "";
      const url = endpoint.includes("chat/completions")
        ? endpoint
        : `${endpoint}/openai/deployments/${encodeURIComponent(modelId)}/chat/completions?api-version=2024-10-21`;
      return fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "api-key": this.credential.apiKey || "" },
        body: JSON.stringify(openaiBody),
        signal,
      });
    }
    return fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${this.credential.apiKey || ""}`,
      },
      body: JSON.stringify(openaiBody),
      signal,
    });
  }

  private responsesRequest(
    messages: Array<Record<string, unknown>>,
    tools: ToolSchema[] | undefined,
    modelId: string,
    forcedToolNames: string[] | undefined,
    signal?: AbortSignal,
    effort: "none" | "low" | "medium" | "high" = "low"
  ): Promise<Response> {
    const body = toResponses(messages, tools, forcedToolNames, this.settings.llmMaxCompletionTokens, modelId, effort);
    return fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${this.credential.apiKey || ""}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  }
}

function toOpenAi(
  messages: Array<Record<string, unknown>>,
  tools: ToolSchema[] | undefined,
  forced: string[] | undefined,
  maxTokens: number,
  modelId: string
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: modelId,
    messages: messages.map(openAiMessage),
    max_completion_tokens: maxTokens,
  };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = openAiToolChoice(forced);
    if (defaultsToReasoning(modelId)) {
      body.reasoning_effort = "none";
    }
  }
  return body;
}

function toResponses(
  messages: Array<Record<string, unknown>>,
  tools: ToolSchema[] | undefined,
  forced: string[] | undefined,
  maxTokens: number,
  modelId: string,
  effort: "none" | "low" | "medium" | "high" = "low"
): Record<string, unknown> {
  const input: unknown[] = [];
  for (const message of messages) {
    const role = String(message.role ?? "user");
    if (role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: String(message.tool_call_id ?? ""),
        output: String(message.content ?? ""),
      });
      continue;
    }
    if (role === "assistant") {
      if (message.content) {
        input.push({ role: "assistant", content: String(message.content) });
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
    if (text) {
      input.push({ role: role === "system" ? "system" : "user", content: text });
    }
  }
  const body: Record<string, unknown> = {
    model: modelId,
    input,
    max_output_tokens: maxTokens,
  };
  if (prefersResponses(modelId)) {
    body.reasoning = { effort };
  }
  if (tools?.length) {
    body.tools = tools.map((tool) => ({
      type: "function",
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    }));
    if (forced?.length === 1) {
      body.tool_choice = { type: "function", name: forced[0] };
    } else if (forced && forced.length > 1) {
      body.tool_choice = "required";
    }
  }
  return body;
}

function prefersResponses(modelId: string): boolean {
  const id = modelId.toLowerCase();
  if (/^o\d/.test(id)) {
    return true;
  }
  const major = /^gpt-(\d+)/.exec(id);
  return Boolean(major && Number(major[1]) >= 5);
}

function defaultsToReasoning(modelId: string): boolean {
  return prefersResponses(modelId);
}

function openAiToolChoice(forced: string[] | undefined): unknown {
  if (!forced?.length) {
    return "auto";
  }
  if (forced.length === 1) {
    return { type: "function", function: { name: forced[0] } };
  }
  return "required";
}

function openAiMessage(message: Record<string, unknown>): Record<string, unknown> {
  const role = String(message.role ?? "user");
  if (role === "assistant" && Array.isArray(message.tool_calls)) {
    const calls = (message.tool_calls as ToolCall[]).map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.function?.name ?? "", arguments: call.function?.arguments ?? "{}" },
    }));
    return { role: "assistant", content: String(message.content ?? "") || null, tool_calls: calls };
  }
  if (role === "tool") {
    return { role: "tool", tool_call_id: String(message.tool_call_id ?? ""), content: String(message.content ?? "") };
  }
  const text = String(message.content ?? "");
  const images = Array.isArray(message.images) ? message.images : [];
  if (!images.length) {
    return { role, content: text };
  }
  const parts: unknown[] = [];
  if (text) {
    parts.push({ type: "text", text });
  }
  for (const image of images) {
    if (!image || typeof image !== "object") {
      continue;
    }
    const data = String((image as { data?: unknown }).data ?? "");
    const mime = String((image as { mime?: unknown }).mime ?? "image/png");
    if (data) {
      parts.push({ type: "image_url", image_url: { url: `data:${mime};base64,${data}` } });
    }
  }
  return { role, content: parts.length ? parts : text };
}

function toAnthropic(
  messages: Array<Record<string, unknown>>,
  tools: ToolSchema[] | undefined,
  forced: string[] | undefined,
  maxTokens: number,
  modelId: string
): Record<string, unknown> {
  const system: string[] = [];
  const converted: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    const role = String(message.role ?? "user");
    if (role === "system") {
      if (message.content) {
        system.push(String(message.content));
      }
      continue;
    }
    if (role === "tool") {
      const block = {
        type: "tool_result",
        tool_use_id: String(message.tool_call_id ?? ""),
        content: String(message.content ?? ""),
      };
      const last = converted[converted.length - 1];
      if (last?.role === "user" && Array.isArray(last.content)) {
        (last.content as unknown[]).push(block);
      } else {
        converted.push({ role: "user", content: [block] });
      }
      continue;
    }
    if (role === "assistant") {
      const content: unknown[] = [];
      if (message.content) {
        content.push({ type: "text", text: String(message.content) });
      }
      for (const call of (message.tool_calls as ToolCall[] | undefined) ?? []) {
        content.push({
          type: "tool_use",
          id: call.id,
          name: call.function?.name ?? "",
          input: parseArgs(call.function?.arguments),
        });
      }
      if (content.length) {
        converted.push({ role: "assistant", content });
      }
      continue;
    }
    converted.push({ role: "user", content: anthropicUserContent(message) });
  }
  const body: Record<string, unknown> = { model: modelId, max_tokens: maxTokens, messages: converted };
  if (system.length) {
    body.system = system.join("\n\n");
  }
  if (tools?.length) {
    body.tools = tools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters,
    }));
    if (forced?.length === 1) {
      body.tool_choice = { type: "tool", name: forced[0] };
    } else if (forced && forced.length > 1) {
      body.tool_choice = { type: "any" };
    }
  }
  return body;
}

function anthropicUserContent(message: Record<string, unknown>): unknown[] {
  const parts: unknown[] = [];
  const text = String(message.content ?? "");
  if (text) {
    parts.push({ type: "text", text });
  }
  for (const image of Array.isArray(message.images) ? message.images : []) {
    if (!image || typeof image !== "object") {
      continue;
    }
    const data = String((image as { data?: unknown }).data ?? "");
    const mime = String((image as { mime?: unknown }).mime ?? "image/png");
    if (data) {
      parts.push({ type: "image", source: { type: "base64", media_type: mime, data } });
    }
  }
  return parts.length ? parts : [{ type: "text", text: text || " " }];
}

function toBedrock(
  messages: Array<Record<string, unknown>>,
  tools: ToolSchema[] | undefined,
  forced: string[] | undefined,
  maxTokens: number
): Record<string, unknown> {
  const system: Array<{ text: string }> = [];
  const converted: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    const role = String(message.role ?? "user");
    if (role === "system") {
      if (message.content) {
        system.push({ text: String(message.content) });
      }
      continue;
    }
    if (role === "tool") {
      const block = {
        toolResult: {
          toolUseId: String(message.tool_call_id ?? ""),
          content: [{ text: String(message.content ?? "") }],
        },
      };
      const last = converted[converted.length - 1];
      if (last?.role === "user" && Array.isArray(last.content)) {
        (last.content as unknown[]).push(block);
      } else {
        converted.push({ role: "user", content: [block] });
      }
      continue;
    }
    if (role === "assistant") {
      const content: unknown[] = [];
      if (message.content) {
        content.push({ text: String(message.content) });
      }
      for (const call of (message.tool_calls as ToolCall[] | undefined) ?? []) {
        content.push({
          toolUse: {
            toolUseId: call.id,
            name: call.function?.name ?? "",
            input: parseArgs(call.function?.arguments),
          },
        });
      }
      if (content.length) {
        converted.push({ role: "assistant", content });
      }
      continue;
    }
    const content: unknown[] = [];
    const text = String(message.content ?? "");
    if (text) {
      content.push({ text });
    }
    for (const image of Array.isArray(message.images) ? message.images : []) {
      if (!image || typeof image !== "object") {
        continue;
      }
      const data = String((image as { data?: unknown }).data ?? "");
      const mime = String((image as { mime?: unknown }).mime ?? "image/png");
      const format = mime.includes("jpeg") || mime.includes("jpg") ? "jpeg" : mime.includes("gif") ? "gif" : mime.includes("webp") ? "webp" : "png";
      if (data) {
        content.push({ image: { format, source: { bytes: data } } });
      }
    }
    converted.push({ role: "user", content: content.length ? content : [{ text: " " }] });
  }
  const body: Record<string, unknown> = {
    messages: converted,
    inferenceConfig: { maxTokens },
  };
  if (system.length) {
    body.system = system;
  }
  if (tools?.length) {
    const toolChoice = !forced?.length
      ? { auto: {} }
      : forced.length === 1
        ? { tool: { name: forced[0] } }
        : { any: {} };
    body.toolConfig = {
      tools: tools.map((tool) => ({
        toolSpec: {
          name: tool.function.name,
          description: tool.function.description,
          inputSchema: { json: tool.function.parameters },
        },
      })),
      toolChoice,
    };
  }
  return body;
}

function parseProviderResponse(provider: string, body: Record<string, unknown>): {
  text: string;
  calls: ToolCall[];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number; cached_tokens: number };
  error?: string;
} {
  const empty = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0 };
  if (typeof body.error === "object" && body.error && "message" in body.error) {
    return { text: "", calls: [], usage: empty, error: String((body.error as { message?: unknown }).message ?? "Request failed") };
  }
  if (typeof body.message === "string" && !body.choices && !body.content && !body.output) {
    return { text: "", calls: [], usage: empty, error: body.message };
  }
  if (provider === "openai-responses") {
    let text = "";
    const calls: ToolCall[] = [];
    const output = Array.isArray(body.output) ? body.output : [];
    for (const block of output) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const item = block as {
        type?: string;
        call_id?: string;
        id?: string;
        name?: string;
        arguments?: unknown;
        content?: Array<{ type?: string; text?: string }>;
      };
      if (item.type === "function_call" && item.name) {
        calls.push(toolCall(item.call_id || item.id, item.name, item.arguments));
      }
      if (item.type === "message" && Array.isArray(item.content)) {
        for (const part of item.content) {
          if ((part?.type === "output_text" || part?.type === "text") && part.text) {
            text += part.text;
          }
        }
      }
    }
    if (!text && typeof body.output_text === "string") {
      text = body.output_text;
    }
    if (!text && !calls.length) {
      const reason = (body.incomplete_details as { reason?: unknown } | undefined)?.reason;
      if (body.status === "incomplete" || typeof reason === "string") {
        const early = (body.usage ?? {}) as Record<string, unknown>;
        return {
          text: "",
          calls,
          usage: readProviderUsage(provider, early),
          error: reason === "max_output_tokens"
            ? "The model used the whole output limit on reasoning and sent no reply."
            : "The model stopped before it wrote a reply.",
        };
      }
    }
    return {
      text,
      calls,
      usage: readProviderUsage(provider, (body.usage ?? {}) as Record<string, unknown>),
    };
  }
  if (provider === "anthropic") {
    const blocks = Array.isArray(body.content) ? body.content : [];
    let text = "";
    const calls: ToolCall[] = [];
    for (const block of blocks) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const item = block as { type?: string; text?: string; id?: string; name?: string; input?: unknown };
      if (item.type === "text" && item.text) {
        text += item.text;
      }
      if (item.type === "tool_use" && item.name) {
        calls.push(toolCall(item.id, item.name, item.input));
      }
    }
    return { text, calls, usage: readProviderUsage(provider, (body.usage ?? {}) as Record<string, unknown>) };
  }
  if (provider === "aws") {
    const output = body.output as { message?: { content?: unknown[] } } | undefined;
    const blocks = output?.message?.content ?? [];
    let text = "";
    const calls: ToolCall[] = [];
    for (const block of blocks) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const item = block as { text?: string; toolUse?: { toolUseId?: string; name?: string; input?: unknown } };
      if (item.text) {
        text += item.text;
      }
      if (item.toolUse?.name) {
        calls.push(toolCall(item.toolUse.toolUseId, item.toolUse.name, item.toolUse.input));
      }
    }
    return { text, calls, usage: readProviderUsage(provider, (body.usage ?? {}) as Record<string, unknown>) };
  }
  const choice = (Array.isArray(body.choices) ? body.choices[0] : undefined) as
    | { message?: { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }
    | undefined;
  const message = choice?.message;
  const calls = (message?.tool_calls ?? []).map((call) => toolCall(call.id, call.function?.name ?? "", call.function?.arguments ?? "{}"));
  return {
    text: message?.content ?? "",
    calls,
    usage: readProviderUsage(provider, (body.usage ?? {}) as Record<string, unknown>),
  };
}

function toolCall(id: string | undefined, name: string, input: unknown): ToolCall {
  return {
    id: id || `call_${randomUUID().replace(/-/g, "").slice(0, 8)}`,
    type: "function",
    function: {
      name,
      arguments: typeof input === "string" ? input : JSON.stringify(input ?? {}),
    },
  };
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}

function chatGptStreamError(event: Record<string, unknown>): string {
  const response = event.response;
  const source = response && typeof response === "object" && !Array.isArray(response) ? response as Record<string, unknown> : event;
  const error = source.error;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }
  if (typeof source.status === "string" && source.status === "incomplete") {
    return "The model stopped before it finished.";
  }
  return "";
}

function redact(text: string, secret?: string): string {
  if (!secret) {
    return text;
  }
  return text.split(secret).join("***");
}

export function signAws(options: {
  method: string;
  url: URL;
  body: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  now?: Date;
}): Record<string, string> {
  const amzDate = (options.now ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256(options.body);
  const canonicalHeaders = `content-type:application/json\nhost:${options.url.host}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "content-type;host;x-amz-date";
  const canonical = [options.method, options.url.pathname, options.url.search, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${dateStamp}/${options.region}/${options.service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonical)}`;
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${options.secretAccessKey}`, dateStamp), options.region), options.service), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  return {
    Authorization: `AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    "content-type": "application/json",
    "x-amz-date": amzDate,
    host: options.url.host,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}
