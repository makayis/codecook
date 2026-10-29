import type { ChatGptCredential, ProviderId, UserCredential } from "./types";

export const ADMIN_GCP_PROJECT = "your-gcp-project-id";

export type SignInProvider = "local" | "google" | "github";

export interface AccountRecord {
  id: string;
  provider: SignInProvider;
  subject: string;
  label: string;
  email?: string;
}

export const LOCAL_ACCOUNT: AccountRecord = {
  id: "local:default",
  provider: "local",
  subject: "default",
  label: "CodeCook",
};

export interface SavedCredential {
  provider: ProviderId;
  source: "api-key" | "gcloud" | "chatgpt-plan";
  apiKey?: string;
  gcpProject?: string;
  gcpLocation?: string;
  azureEndpoint?: string;
  awsSecret?: string;
  awsRegion?: string;
  model?: string;
  chatgpt?: ChatGptCredential;
}

export interface CredentialInput {
  provider?: string;
  source?: string;
  apiKey?: string;
  gcpProject?: string;
  azureEndpoint?: string;
  awsSecret?: string;
  awsRegion?: string;
  model?: string;
}

export function isReservedProject(project: string | undefined): boolean {
  return (project || "").trim() === ADMIN_GCP_PROJECT;
}

export function credentialFor(saved: SavedCredential | null): UserCredential | null {
  if (saved?.source === "chatgpt-plan") {
    return chatGptCredential(saved);
  }
  return saved ? savedCredential(saved) : null;
}

const PLAN_SCOPE = "chatgpt.tokens.use.direct";

function chatGptCredential(saved: SavedCredential): UserCredential | null {
  const session = saved.chatgpt;
  if (!session?.accessToken || !session.clientId || !session.scopes?.includes(PLAN_SCOPE)) {
    return null;
  }
  return {
    provider: "openai",
    source: "chatgpt-plan",
    apiKey: session.accessToken,
    model: saved.model,
  };
}

function savedCredential(saved: SavedCredential): UserCredential | null {
  if (saved.source === "gcloud") {
    if (!saved.gcpProject || isReservedProject(saved.gcpProject)) {
      return null;
    }
    return {
      provider: "google",
      source: "gcloud",
      gcpProject: saved.gcpProject,
      gcpLocation: saved.gcpLocation || "global",
      model: saved.model,
    };
  }
  if (saved.provider === "aws") {
    if (!saved.apiKey || !saved.awsSecret || !saved.awsRegion) {
      return null;
    }
  } else if (saved.provider === "azure") {
    if (!saved.apiKey || !saved.azureEndpoint) {
      return null;
    }
  } else if (!saved.apiKey) {
    return null;
  }
  return {
    provider: saved.provider,
    source: "api-key",
    apiKey: saved.apiKey,
    azureEndpoint: saved.azureEndpoint,
    awsSecret: saved.awsSecret,
    awsRegion: saved.awsRegion,
    model: saved.model,
  };
}

export function normalizeSaved(input: CredentialInput): SavedCredential | { error: string } {
  const provider = input.provider;
  const model = input.model?.trim() || undefined;
  if (provider === "google" && input.source === "gcloud") {
    const project = input.gcpProject?.trim() || "";
    if (!project) {
      return { error: "Enter the Google Cloud project for this account." };
    }
    if (isReservedProject(project)) {
      return { error: "That Google Cloud project cannot be used." };
    }
    return { provider: "google", source: "gcloud", gcpProject: project, gcpLocation: "global", model };
  }
  if (provider !== "google" && provider !== "openai" && provider !== "anthropic" && provider !== "azure" && provider !== "aws") {
    return { error: "Choose a provider." };
  }
  if (provider === "aws") {
    const apiKey = input.apiKey?.trim() || "";
    const awsSecret = input.awsSecret?.trim() || "";
    const awsRegion = input.awsRegion?.trim() || "";
    if (!apiKey || !awsSecret || !awsRegion) {
      return { error: "Enter the AWS access key, secret, and region." };
    }
    return { provider: "aws", source: "api-key", apiKey, awsSecret, awsRegion, model };
  }
  if (provider === "azure") {
    const apiKey = input.apiKey?.trim() || "";
    const azureEndpoint = input.azureEndpoint?.trim().replace(/\/+$/, "") || "";
    if (!apiKey || !azureEndpoint) {
      return { error: "Enter the Azure endpoint and API key." };
    }
    return { provider: "azure", source: "api-key", apiKey, azureEndpoint, model };
  }
  const apiKey = input.apiKey?.trim() || "";
  if (!apiKey) {
    return { error: "Enter an API key." };
  }
  return { provider, source: "api-key", apiKey, model };
}

export function ambientChoices(env: NodeJS.ProcessEnv): Array<{ id: string; label: string }> {
  const choices: Array<{ id: string; label: string }> = [];
  if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY) {
    choices.push({ id: "gemini", label: "Google API key from the environment" });
  }
  if (env.OPENAI_API_KEY) {
    choices.push({ id: "openai", label: "ChatGPT API key from the environment" });
  }
  if (env.ANTHROPIC_API_KEY) {
    choices.push({ id: "anthropic", label: "Claude API key from the environment" });
  }
  if (env.AZURE_OPENAI_API_KEY && env.AZURE_OPENAI_ENDPOINT) {
    choices.push({ id: "azure", label: "Azure OpenAI key from the environment" });
  }
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
    choices.push({ id: "aws", label: "AWS keys from the environment" });
  }
  return choices;
}

export function ambientCredential(id: string, env: NodeJS.ProcessEnv): SavedCredential | { error: string } {
  if (id === "gemini") {
    return normalizeSaved({ provider: "google", source: "api-key", apiKey: env.GEMINI_API_KEY || env.GOOGLE_API_KEY || "" });
  }
  if (id === "openai") {
    return normalizeSaved({ provider: "openai", source: "api-key", apiKey: env.OPENAI_API_KEY || "" });
  }
  if (id === "anthropic") {
    return normalizeSaved({ provider: "anthropic", source: "api-key", apiKey: env.ANTHROPIC_API_KEY || "" });
  }
  if (id === "azure") {
    return normalizeSaved({
      provider: "azure",
      source: "api-key",
      apiKey: env.AZURE_OPENAI_API_KEY || "",
      azureEndpoint: env.AZURE_OPENAI_ENDPOINT || "",
    });
  }
  if (id === "aws") {
    return normalizeSaved({
      provider: "aws",
      source: "api-key",
      apiKey: env.AWS_ACCESS_KEY_ID || "",
      awsSecret: env.AWS_SECRET_ACCESS_KEY || "",
      awsRegion: env.AWS_REGION || env.AWS_DEFAULT_REGION || "",
    });
  }
  return { error: "That environment key is not available." };
}
