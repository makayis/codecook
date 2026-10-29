import { chatGptModelIds } from "./chatgptPlan";
import { getAccessToken } from "./llm";
import { signAws } from "./llmClient";
import type { UserCredential } from "./types";

const LIST_TIMEOUT_MS = 20_000;

export async function fetchModelIds(credential: UserCredential): Promise<string[]> {
  if (credential.source === "vertex-admin") {
    return [];
  }
  if (credential.provider === "openai" && credential.source === "chatgpt-plan") {
    return chatGptModelIds(await getJson("https://api.openai.com/v1/models", { Authorization: `Bearer ${credential.apiKey || ""}` }));
  }
  if (credential.provider === "openai") {
    return idsFromData(await getJson("https://api.openai.com/v1/models", { Authorization: `Bearer ${credential.apiKey || ""}` }));
  }
  if (credential.provider === "anthropic") {
    return idsFromData(
      await getJson("https://api.anthropic.com/v1/models", {
        "x-api-key": credential.apiKey || "",
        "anthropic-version": "2023-06-01",
      })
    );
  }
  if (credential.provider === "google" && credential.apiKey) {
    return fetchGoogle(credential.apiKey);
  }
  if (credential.provider === "google" && credential.gcpProject) {
    return fetchVertexProject(credential.gcpProject);
  }
  if (credential.provider === "azure" && credential.azureEndpoint && credential.apiKey) {
    const endpoint = credential.azureEndpoint.replace(/\/+$/, "");
    const body = await getJson(`${endpoint}/openai/deployments?api-version=2023-03-15-preview`, { "api-key": credential.apiKey });
    return idsFromData(body);
  }
  if (credential.provider === "aws" && credential.apiKey && credential.awsSecret && credential.awsRegion) {
    return fetchBedrock(credential.awsRegion, credential.apiKey, credential.awsSecret);
  }
  return [];
}

async function fetchGoogle(apiKey: string): Promise<string[]> {
  let geminiError: Error | undefined;
  try {
    const ids = await fetchGeminiApi(apiKey);
    if (ids.length) {
      return ids;
    }
  } catch (err) {
    geminiError = err instanceof Error ? err : new Error(String(err));
  }
  try {
    const ids = await fetchPublisherModels(publisherListUrls(""), {}, apiKey);
    if (ids.length) {
      return ids;
    }
  } catch (err) {
    if (geminiError && /HTTP 400\b|HTTP 403\b/.test(geminiError.message)) {
      throw geminiError;
    }
    throw err;
  }
  if (geminiError) {
    throw geminiError;
  }
  return [];
}

async function fetchGeminiApi(apiKey: string): Promise<string[]> {
  const ids: string[] = [];
  let page = "";
  for (let i = 0; i < 5; i++) {
    const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
    url.searchParams.set("key", apiKey);
    url.searchParams.set("pageSize", "100");
    if (page) {
      url.searchParams.set("pageToken", page);
    }
    const body = await getJson(url.toString(), {}, "GET", LIST_TIMEOUT_MS);
    const models = Array.isArray(body.models) ? body.models : [];
    for (const model of models) {
      if (!model || typeof model !== "object" || !("name" in model)) {
        continue;
      }
      const item = model as { name?: unknown; supportedGenerationMethods?: unknown };
      const methods = Array.isArray(item.supportedGenerationMethods) ? item.supportedGenerationMethods.map(String) : [];
      if (methods.length && !methods.includes("generateContent")) {
        continue;
      }
      const id = publisherModelId(String(item.name ?? ""));
      if (id) {
        ids.push(id);
      }
    }
    page = typeof body.nextPageToken === "string" ? body.nextPageToken : "";
    if (!page) {
      break;
    }
  }
  return ids;
}

async function fetchVertexProject(project: string): Promise<string[]> {
  const token = await getAccessToken();
  return fetchPublisherModels(publisherListUrls(project), {
    Authorization: `Bearer ${token}`,
    "x-goog-user-project": project,
  });
}

function publisherListUrls(project: string): string[] {
  const urls = [
    "https://aiplatform.googleapis.com/v1beta1/publishers/google/models",
    "https://us-central1-aiplatform.googleapis.com/v1beta1/publishers/google/models",
  ];
  const id = project.trim();
  if (id) {
    const encoded = encodeURIComponent(id);
    urls.push(
      `https://aiplatform.googleapis.com/v1/projects/${encoded}/locations/global/publishers/google/models`,
      `https://us-central1-aiplatform.googleapis.com/v1/projects/${encoded}/locations/us-central1/publishers/google/models`
    );
  }
  return urls;
}

async function fetchPublisherModels(urls: string[], headers: Record<string, string>, apiKey?: string): Promise<string[]> {
  const errors: string[] = [];
  for (const base of urls) {
    try {
      const ids = await pagePublisherModels(base, headers, apiKey);
      if (ids.length) {
        return ids;
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  throw new Error(errors[0] || "Google did not return any Gemini models.");
}

async function pagePublisherModels(base: string, headers: Record<string, string>, apiKey?: string): Promise<string[]> {
  try {
    return await readPublisherPage(base, headers, apiKey, true);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/HTTP 400\b/.test(message)) {
      throw err;
    }
    return readPublisherPage(base, headers, apiKey, false);
  }
}

async function readPublisherPage(base: string, headers: Record<string, string>, apiKey: string | undefined, pageSize: boolean): Promise<string[]> {
  const ids: string[] = [];
  let page = "";
  for (let i = 0; i < 5; i++) {
    const url = new URL(base);
    if (pageSize) {
      url.searchParams.set("pageSize", "100");
    }
    if (page) {
      url.searchParams.set("pageToken", page);
    }
    if (apiKey) {
      url.searchParams.set("key", apiKey);
    }
    const body = await getJson(url.toString(), headers, "GET", LIST_TIMEOUT_MS);
    const models = Array.isArray(body.publisherModels) ? body.publisherModels : Array.isArray(body.models) ? body.models : [];
    for (const model of models) {
      if (!model || typeof model !== "object") {
        continue;
      }
      const item = model as { name?: unknown; modelId?: unknown; versionId?: unknown };
      const id = publisherModelId(String(item.name ?? item.modelId ?? item.versionId ?? ""));
      if (id.toLowerCase().startsWith("gemini")) {
        ids.push(id);
      }
    }
    page = typeof body.nextPageToken === "string" ? body.nextPageToken : "";
    if (!page) {
      break;
    }
  }
  return ids;
}

function publisherModelId(name: string): string {
  const id = name.trim().split("/").pop() || "";
  return id.split("@")[0].trim();
}

async function fetchBedrock(region: string, accessKeyId: string, secret: string): Promise<string[]> {
  const url = new URL(`https://bedrock.${region}.amazonaws.com/foundation-models`);
  const headers = signAws({
    method: "GET",
    url,
    body: "",
    accessKeyId,
    secretAccessKey: secret,
    region,
    service: "bedrock",
  });
  const body = await getJson(url.toString(), headers, "GET");
  const summaries = Array.isArray(body.modelSummaries) ? body.modelSummaries : [];
  const ids: string[] = [];
  for (const item of summaries) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const summary = item as { modelId?: unknown; outputModalities?: unknown; inferenceTypesSupported?: unknown };
    const outputs = Array.isArray(summary.outputModalities) ? summary.outputModalities.map(String) : [];
    const kinds = Array.isArray(summary.inferenceTypesSupported) ? summary.inferenceTypesSupported.map(String) : [];
    if (!outputs.includes("TEXT") || !kinds.includes("ON_DEMAND")) {
      continue;
    }
    if (summary.modelId) {
      ids.push(String(summary.modelId));
    }
  }
  return ids;
}

function idsFromData(body: Record<string, unknown>): string[] {
  const rows = Array.isArray(body.data) ? body.data : Array.isArray(body.value) ? body.value : [];
  return rows
    .map((row) => {
      if (!row || typeof row !== "object") {
        return "";
      }
      const item = row as { id?: unknown; name?: unknown };
      return String(item.id ?? item.name ?? "");
    })
    .filter(Boolean);
}

async function getJson(url: string, headers: Record<string, string>, method = "GET", timeoutMs = 8000): Promise<Record<string, unknown>> {
  const response = await fetch(url, { method, headers, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let body: unknown = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = {};
    }
  }
  if (!response.ok) {
    const detail = errorDetail(body) || text.trim().slice(0, 300);
    throw new Error(detail ? `HTTP ${response.status}: ${detail}` : `HTTP ${response.status}`);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {};
  }
  return body as Record<string, unknown>;
}

function errorDetail(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "";
  }
  const record = body as { error?: unknown; message?: unknown };
  const error = record.error;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message ?? "").trim();
  }
  if (typeof error === "string") {
    return error.trim();
  }
  if (typeof record.message === "string") {
    return record.message.trim();
  }
  return "";
}
