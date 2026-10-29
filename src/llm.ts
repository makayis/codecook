import { GoogleAuth } from "google-auth-library";
import { randomUUID } from "crypto";
import { log } from "./log";
import { mergeTextPieces, parseVertexStream } from "./stream";
import type { LlmClient, LlmEvent, Settings, ToolCall, ToolSchema, UserCredential } from "./types";

const ADC_HELP =
  "Vertex AI credentials were not found. Run: gcloud auth application-default login";

function vertexHost(location: string): string {
  return location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
}

function convertSchema(schema: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!schema) {
    return undefined;
  }
  const typeMap: Record<string, string> = {
    string: "STRING",
    integer: "INTEGER",
    number: "NUMBER",
    boolean: "BOOLEAN",
    array: "ARRAY",
    object: "OBJECT",
  };
  const rawType = String(schema.type ?? "string").toLowerCase();
  const out: Record<string, unknown> = { type: typeMap[rawType] ?? "STRING" };
  if (schema.description) {
    out.description = schema.description;
  }
  if (schema.enum) {
    out.enum = schema.enum;
  }
  if (schema.properties && typeof schema.properties === "object") {
    const props: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema.properties as Record<string, Record<string, unknown>>)) {
      props[key] = convertSchema(value);
    }
    out.properties = props;
  }
  if (schema.required) {
    out.required = schema.required;
  }
  if (schema.items && typeof schema.items === "object") {
    out.items = convertSchema(schema.items as Record<string, unknown>);
  }
  return out;
}

function convertToolSchemas(tools?: ToolSchema[]): unknown[] | undefined {
  if (!tools?.length) {
    return undefined;
  }
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        parameters: convertSchema(tool.function.parameters as Record<string, unknown>),
      })),
    },
  ];
}

function findToolName(messages: Array<Record<string, unknown>>, toolCallId: string): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls as ToolCall[]) {
        if (tc.id === toolCallId) {
          return tc.function?.name ?? "unknown";
        }
      }
    }
  }
  return "unknown";
}

export function convertMessages(
  messages: Array<Record<string, unknown>>,
  modelId = ""
): { systemInstruction?: { parts: Array<{ text: string }> }; contents: unknown[] } {
  let systemInstruction: { parts: Array<{ text: string }> } | undefined;
  const contents: unknown[] = [];
  let pendingToolResponses: unknown[] = [];

  for (const msg of messages) {
    const role = String(msg.role ?? "user");
    const content = msg.content ?? "";

    if (role === "system") {
      systemInstruction = { parts: [{ text: String(content) }] };
      continue;
    }

    if (role === "user") {
      const parts: unknown[] = [...pendingToolResponses];
      pendingToolResponses = [];
      if (typeof content === "string" && content) {
        const last = parts[parts.length - 1] as { functionResponse?: { response?: { result?: string } } } | undefined;
        if (last?.functionResponse?.response) {
          const prior = last.functionResponse.response.result ?? "";
          last.functionResponse.response.result = `${prior}\n\n${content}`;
        } else {
          parts.push({ text: content });
        }
      }
      if (Array.isArray(msg.images)) {
        for (const image of msg.images) {
          if (!image || typeof image !== "object") {
            continue;
          }
          const data = String((image as { data?: unknown }).data ?? "");
          const mime = String((image as { mime?: unknown }).mime ?? "");
          if (data && mime) {
            parts.push({ inlineData: { mimeType: mime, data } });
          }
        }
      }
      if (parts.length) {
        contents.push({ role: "user", parts });
      }
      continue;
    }

    if (role === "assistant") {
      if (pendingToolResponses.length) {
        contents.push({ role: "user", parts: pendingToolResponses });
        pendingToolResponses = [];
      }
      const parts: unknown[] = [];
      if (typeof content === "string" && content) {
        parts.push({ text: content });
      }
      const toolCalls = (msg.tool_calls as ToolCall[] | undefined) ?? [];
      let sawFunctionCall = false;
      for (const tc of toolCalls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function?.arguments || "{}");
        } catch {
          args = {};
        }
        const part: Record<string, unknown> = {
          functionCall: { id: tc.id, name: tc.function?.name ?? "", args },
        };
        if (tc.thought_signature) {
          part.thoughtSignature = tc.thought_signature;
        } else if (!sawFunctionCall && isGemini3(modelId)) {
          part.thoughtSignature = Buffer.from("0".repeat(16)).toString("base64");
        }
        sawFunctionCall = true;
        parts.push(part);
      }
      if (parts.length) {
        contents.push({ role: "model", parts });
      }
      continue;
    }

    if (role === "tool") {
      const callId = String(msg.tool_call_id ?? "");
      pendingToolResponses.push({
        functionResponse: {
          id: callId,
          name: findToolName(messages, callId),
          response: { result: String(content) },
        },
      });
    }
  }

  if (pendingToolResponses.length) {
    contents.push({ role: "user", parts: pendingToolResponses });
  }
  return { systemInstruction, contents };
}

export async function getAccessToken(): Promise<string> {
  try {
    const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
    const client = await auth.getClient();
    const token = await client.getAccessToken();
    if (!token.token) {
      throw new Error(ADC_HELP);
    }
    return token.token;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/Could not load the default credentials|ENOENT|invalid_grant|ADC|application-default/i.test(message)) {
      throw new Error(ADC_HELP);
    }
    throw new Error(`${ADC_HELP}\n${message}`);
  }
}

export class VertexLlmClient implements LlmClient {
  private keyRoute?: "gemini" | "vertex";

  constructor(
    private settings: Settings,
    private credential?: UserCredential
  ) {}

  async *streamChat(
    messages: Array<Record<string, unknown>>,
    tools: ToolSchema[] | undefined,
    model: string,
    signal?: AbortSignal,
    thinking?: string,
    forcedToolNames?: string[]
  ): AsyncGenerator<LlmEvent> {
    const modelId = model || this.credential?.model || this.settings.model;
    const { systemInstruction, contents } = convertMessages(messages, modelId);
    const usingApiKey = Boolean(this.credential?.provider === "google" && this.credential.source === "api-key" && this.credential.apiKey);
    const project = this.credential?.gcpProject || this.settings.gcpProject;
    const location = this.credential?.gcpLocation || this.settings.gcpLocation || "global";
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${this.credential?.apiKey}`;
    const vertexKeyUrl = `https://aiplatform.googleapis.com/v1/publishers/google/models/${modelId}:generateContent?key=${this.credential?.apiKey}`;
    const projectUrl =
      `https://${vertexHost(location)}/v1/projects/${project}` +
      `/locations/${location}/publishers/google/models/${modelId}:generateContent`;

    const generationConfig: Record<string, unknown> = {
      maxOutputTokens: this.settings.llmMaxCompletionTokens,
    };
    const thought = thinkingConfig(modelId, messages, thinking);
    if (Object.keys(thought).length) {
      generationConfig.thinkingConfig = thought;
    }
    const body: Record<string, unknown> = {
      contents,
      generationConfig,
    };
    if (systemInstruction) {
      body.systemInstruction = systemInstruction;
    }
    const geminiTools = convertToolSchemas(tools);
    if (geminiTools) {
      body.tools = geminiTools;
      body.toolConfig = forcedToolNames?.length
        ? { functionCallingConfig: { mode: "ANY", allowedFunctionNames: forcedToolNames } }
        : { functionCallingConfig: { mode: "AUTO" } };
    }

    const maxRetries = 5;
    const baseDelay = 2000;
    let accumulatedText = "";
    let accumulatedThought = "";
    let accumulatedCalls: ToolCall[] = [];
    let usageData: { prompt_tokens: number; completion_tokens: number; total_tokens: number; cached_tokens: number } = {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      cached_tokens: 0,
    };

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (signal?.aborted) {
        yield { type: "error", error: "Cancelled", model: modelId };
        return;
      }
      accumulatedText = "";
      accumulatedThought = "";
      accumulatedCalls = [];
      try {
        if (signal?.aborted) {
          yield { type: "error", error: "Cancelled", model: modelId };
          return;
        }
        yield { type: "status", message: "Thinking…" };
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (!usingApiKey) {
          const token = await getAccessToken();
          if (signal?.aborted) {
            yield { type: "error", error: "Cancelled", model: modelId };
            return;
          }
          headers.Authorization = `Bearer ${token}`;
        }
        const url = usingApiKey ? (this.keyRoute === "vertex" ? vertexKeyUrl : geminiUrl) : projectUrl;
        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal,
        });

        if (!response.ok) {
          const errText = await response.text();
          if (
            usingApiKey &&
            this.keyRoute !== "vertex" &&
            (response.status === 400 || response.status === 401 || response.status === 403 || response.status === 404)
          ) {
            this.keyRoute = "vertex";
            attempt -= 1;
            continue;
          }
          const error = new Error(`HTTP ${response.status}: ${errText.slice(0, 800)}`);
          (error as Error & { status: number }).status = response.status;
          throw error;
        }
        if (usingApiKey) {
          this.keyRoute = this.keyRoute ?? "gemini";
        }

        const raw = await response.text();
        const parsedBody = parseVertexStream(raw);
        const pieces: string[] = [];
        const thoughtPieces: string[] = [];
        accumulatedCalls = [];
        for (const event of parsedBody.length ? parsedBody : raw.trim() ? [JSON.parse(raw)] : []) {
          const parsed = this.consumeChunk(event, modelId);
          pieces.push(parsed.text);
          thoughtPieces.push(parsed.thought);
          accumulatedCalls.push(...parsed.calls);
          if (parsed.usage) {
            usageData = parsed.usage;
          }
          if (parsed.events.some((ev) => ev.type === "error") && !parsed.text) {
            const err = parsed.events.find((ev) => ev.type === "error");
            if (err?.type === "error") {
              throw new Error(err.error);
            }
          }
        }
        accumulatedText = mergeTextPieces(pieces);
        accumulatedThought = mergeTextPieces(thoughtPieces);
        if (accumulatedThought) {
          yield { type: "thought_delta", text: accumulatedThought };
        }
        if (accumulatedText) {
          yield { type: "content_delta", text: accumulatedText };
        }
        if (!accumulatedText && !accumulatedCalls.length) {
          log(`Empty Vertex response for ${modelId}. Body: ${raw.slice(0, 2000)}`);
        }
        break;
      } catch (err) {
        const message = redactSecret(err instanceof Error ? err.message : String(err), this.credential?.apiKey);
        if (signal?.aborted || isAbortError(err)) {
          yield { type: "error", error: "Cancelled", model: modelId };
          return;
        }
        const status = (err as { status?: number }).status;
        const retryable =
          status === 429 ||
          status === 500 ||
          status === 503 ||
          /429|RESOURCE_EXHAUSTED|503|500|UNAVAILABLE/i.test(message);
        if (retryable && attempt < maxRetries) {
          const delay = baseDelay * 2 ** attempt;
          yield {
            type: "status",
            message: `Rate limited — retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${maxRetries})...`,
          };
          try {
            await abortableSleep(delay, signal);
          } catch {
            yield { type: "error", error: "Cancelled", model: modelId };
            return;
          }
          continue;
        }
        if (retryable) {
          yield {
            type: "error",
            error: usingApiKey
              ? `Gemini quota or rate limit reached (${message}). Wait and try again.`
              : `Vertex quota or free-trial limit reached (${message}). This is a GCP rate limit, not a model failure. Wait and try again, or check the project's Vertex AI quota.`,
            model: modelId,
          };
          return;
        }
        yield { type: "error", error: `LLM API error: ${message}`, model: modelId };
        return;
      }
    }

    if (usageData.total_tokens) {
      yield { type: "usage", ...usageData };
    }
    if (accumulatedCalls.length) {
      yield { type: "tool_calls", calls: accumulatedCalls };
    }
    yield {
      type: "done",
      text: accumulatedText,
      tool_calls: accumulatedCalls,
      usage: usageData,
      finish_reason: accumulatedCalls.length ? "tool_calls" : "stop",
    };
  }

  private consumeChunk(
    event: unknown,
    modelId: string
  ): {
    text: string;
    thought: string;
    calls: ToolCall[];
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number; cached_tokens: number };
    events: LlmEvent[];
  } {
    const chunk = event as {
      candidates?: Array<{ content?: { parts?: Array<Record<string, unknown>>; role?: string } | string }>;
      usageMetadata?: Record<string, number>;
      error?: { message?: string };
    };
    if (chunk.error?.message) {
      return {
        text: "",
        thought: "",
        calls: [],
        events: [{ type: "error", error: chunk.error.message, model: modelId }],
      };
    }
    let text = "";
    let thought = "";
    const calls: ToolCall[] = [];
    const events: LlmEvent[] = [];
    let usage:
      | { prompt_tokens: number; completion_tokens: number; total_tokens: number; cached_tokens: number }
      | undefined;

    if (chunk.usageMetadata) {
      usage = {
        prompt_tokens: chunk.usageMetadata.promptTokenCount ?? 0,
        completion_tokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
        total_tokens: chunk.usageMetadata.totalTokenCount ?? 0,
        cached_tokens: chunk.usageMetadata.cachedContentTokenCount ?? 0,
      };
    }

    const content = chunk.candidates?.[0]?.content;
    if (typeof content === "string" && content) {
      return {
        text: content,
        thought: "",
        calls: [],
        usage,
        events: [{ type: "content_delta", text: content }],
      };
    }
    const parts = (content && typeof content === "object" ? content.parts : undefined) ?? [];
    for (const part of parts) {
      const fc = (part.functionCall ?? part.function_call) as { id?: string; name?: string; args?: Record<string, unknown> } | undefined;
      if (part.thought === true && !fc?.name) {
        if (typeof part.text === "string" && part.text) {
          thought += part.text;
          events.push({ type: "thought_delta", text: part.text });
        }
        continue;
      }
      if (typeof part.text === "string" && part.text && part.thought !== true) {
        text += part.text;
        events.push({ type: "content_delta", text: part.text });
      }
      if (fc?.name) {
        const sig = (part.thoughtSignature ?? part.thought_signature) as string | undefined;
        const call: ToolCall = {
          id: fc.id || `call_${randomUUID().replace(/-/g, "").slice(0, 8)}`,
          type: "function",
          function: {
            name: fc.name,
            arguments: JSON.stringify(fc.args ?? {}),
          },
        };
        if (sig) {
          call.thought_signature = typeof sig === "string" ? sig : Buffer.from(sig).toString("base64");
        } else if (calls.length === 0 && isGemini3(modelId)) {
          call.thought_signature = Buffer.from("0".repeat(16)).toString("base64");
        }
        calls.push(call);
      }
    }
    return { text, thought, calls, usage, events };
  }
}

function isGemini3(modelId: string): boolean {
  return modelId.includes("gemini-3");
}

function thinkingConfig(
  modelId: string,
  messages: Array<Record<string, unknown>>,
  choice?: string
): Record<string, unknown> {
  if (!isGemini3(modelId)) {
    return {};
  }
  if (choice === "off") {
    return { thinkingLevel: "low" };
  }
  const picked = choice === "LOW" || choice === "MEDIUM" || choice === "HIGH" ? choice : "";
  const level = picked || (deepTurn(messages) ? "HIGH" : "LOW");
  const config: Record<string, unknown> = { thinkingLevel: level.toLowerCase() };
  if (picked || level !== "LOW") {
    config.includeThoughts = true;
  }
  return config;
}

export async function describeImages(
  client: LlmClient,
  images: Array<{ mime: string; data: string }>,
  signal?: AbortSignal,
  models: string[] = ["gemini-3.8-flash", "gemini-2.5-flash"]
): Promise<string | undefined> {
  const messages = [
    {
      role: "user",
      content: "Describe each image for another coding assistant. Transcribe any visible text. Be specific and concise.",
      images,
    },
  ];
  for (const model of models) {
    if (signal?.aborted) {
      return undefined;
    }
    let text = "";
    let failed = false;
    try {
      for await (const event of client.streamChat(messages, undefined, model, signal, "off")) {
        if (event.type === "content_delta") {
          text += event.text;
        } else if (event.type === "done") {
          text = event.text || text;
        } else if (event.type === "error") {
          if (event.error === "Cancelled" || signal?.aborted) {
            return undefined;
          }
          failed = true;
          break;
        }
      }
    } catch {
      if (signal?.aborted) {
        return undefined;
      }
      failed = true;
    }
    if (!failed && text.trim()) {
      return text.trim();
    }
  }
  return undefined;
}

const DEEP_TURN = /\b(implement|refactor|fix|generate|create|build|write|edit|plan|migrate|rewrite|debug|code|function|file)\b/i;

function deepTurn(messages: Array<Record<string, unknown>>): boolean {
  const working = messages.some(
    (message) =>
      message.role === "tool" ||
      (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0)
  );
  if (working) {
    return true;
  }
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  const text = String(lastUser?.content ?? "")
    .replace(/--- Context file:[\s\S]*?--- End context file ---\n*/g, "")
    .trim();
  return text.length > 280 || DEEP_TURN.test(text);
}

function redactSecret(text: string, secret?: string): string {
  if (!secret) {
    return text;
  }
  return text.split(secret).join("***");
}

function isAbortError(err: unknown): boolean {
  const name = err instanceof Error ? err.name : "";
  const message = err instanceof Error ? err.message : String(err);
  return name === "AbortError" || /aborted|AbortError/i.test(message);
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
