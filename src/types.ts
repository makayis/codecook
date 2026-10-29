export type Role = "system" | "user" | "assistant" | "tool";
export type Mode = "chat" | "agent" | "plan";
export type TaskType = "chat" | "plan" | "generate" | "refactor" | "agent";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  thought_signature?: string;
  status?: string;
  result?: string | null;
}

export interface Attachment {
  name: string;
  mime: string;
  path: string;
  kind: "image" | "document";
}

export interface Mention {
  id?: string;
  kind: "file" | "selection" | "terminal";
  label: string;
  path?: string;
  text?: string;
}

export interface Message {
  seq: number;
  role: Role;
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  usage?: Usage;
  hidden?: boolean;
  notice?: boolean;
  attachments?: Attachment[];
  mentions?: Mention[];
}

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cached_tokens?: number;
}

export interface Todo {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}

export interface Plan {
  title: string;
  overview: string;
  body_md: string;
  status: "draft" | "approved";
}

export interface Summary {
  summary_text: string;
  through_seq: number;
  summary_count: number;
}

export interface Chat {
  id: string;
  title: string;
  mode: Mode;
  model?: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
  plan?: Plan;
  todos?: Todo[];
  summary?: Summary;
}

export interface StoreData {
  chats: Chat[];
  activeChatId: string | null;
}

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface QuestionOption {
  id: string;
  label: string;
}

export interface PlanQuestion {
  id: string;
  prompt: string;
  options: QuestionOption[];
  recommended?: string;
}

export interface ToolResult {
  text: string;
  ok: boolean;
  todos?: Todo[];
  title?: string;
  overview?: string;
  plan_md?: string;
  questions?: PlanQuestion[];
}

export type ProviderId = "google" | "openai" | "anthropic" | "azure" | "aws";

export interface ChatGptCredential {
  email?: string;
  subject: string;
  clientId: string;
  hostId: string;
  idToken?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes: string[];
}

export interface UserCredential {
  provider: ProviderId;
  source: "vertex-admin" | "api-key" | "gcloud" | "chatgpt-plan";
  apiKey?: string;
  gcpProject?: string;
  gcpLocation?: string;
  azureEndpoint?: string;
  awsSecret?: string;
  awsRegion?: string;
  model?: string;
}

export interface LlmClient {
  streamChat(
    messages: Array<Record<string, unknown>>,
    tools: ToolSchema[] | undefined,
    model: string,
    signal?: AbortSignal,
    thinking?: string,
    forcedToolNames?: string[]
  ): AsyncGenerator<LlmEvent>;
}

export type LlmEvent =
  | { type: "content_delta"; text: string }
  | { type: "thought_delta"; text: string }
  | { type: "tool_calls"; calls: ToolCall[] }
  | { type: "usage"; prompt_tokens: number; completion_tokens: number; total_tokens: number; cached_tokens: number }
  | { type: "status"; message: string }
  | { type: "done"; text: string; tool_calls: ToolCall[]; usage: Usage; finish_reason: string }
  | { type: "error"; error: string; model?: string };

export type TurnEvent =
  | { type: "chat_id"; chat_id: string }
  | { type: "model_selected"; model: string; reason: string; automatic: boolean }
  | { type: "content_delta"; text: string }
  | { type: "thought_delta"; text: string }
  | { type: "tool_call_start"; name: string; arguments: string; call_id: string }
  | { type: "tool_call_result"; name: string; result: string; call_id: string; ok: boolean }
  | { type: "todos_updated"; todos: Todo[]; plan?: Partial<Plan> }
  | { type: "questions"; questions: PlanQuestion[] }
  | { type: "summarizing" }
  | { type: "status"; message: string }
  | { type: "error"; error: string }
  | { type: "done" }
  | {
      type: "context";
      percent: number;
      label: string;
      used?: number;
      budget?: number;
      saved?: number;
      saved_truncation?: number;
      saved_history?: number;
      elided?: number;
      rules_tokens?: number;
      tools_tokens?: number;
      user_tokens?: number;
      history_full?: number;
      history_sent?: number;
    }
  | {
      type: "usage";
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      cached_tokens?: number;
      saved?: number;
      used?: number;
      budget?: number;
      costUsd?: number;
      model?: string;
      taskType?: TaskType;
      month?: MonthUsage;
      rules_tokens?: number;
      tools_tokens?: number;
      user_tokens?: number;
      history_full?: number;
      history_sent?: number;
    };

export interface TokenStats {
  percent: number;
  used: number;
  budget: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_tokens: number;
  saved: number;
  saved_truncation: number;
  saved_history: number;
  elided: number;
  costUsd: number;
  model: string;
  taskType: TaskType | "";
  month: MonthUsage;
  recentCosts: number[];
  periods: PeriodSpend[];
  rules_tokens: number;
  tools_tokens: number;
  user_tokens: number;
  historyFull: number;
  historySent: number;
  sessionSavedTokens: number;
  sessionSavedUsd: number;
  sessionCacheUsd: number;
  sessionSummaries: number;
}

export type PeriodKind = "day" | "week" | "month";

export interface PeriodSpend {
  kind: PeriodKind;
  used: number;
  limit: number;
  left: number | null;
  forecast: number;
  pct: number;
}

export interface UsageRecord {
  ts: number;
  chatId: string;
  model: string;
  mode: Mode;
  taskType: TaskType;
  prompt: number;
  completion: number;
  cached: number;
  saved: number;
  used: number;
  costUsd: number;
  historyFull?: number;
  historySent?: number;
  kind?: "turn" | "summary";
}

export interface TaskUsage {
  tokens: number;
  costUsd: number;
  count: number;
}

export interface MonthUsage {
  key: string;
  tokens: number;
  costUsd: number;
  saved: number;
  used: number;
  byTask: Record<TaskType, TaskUsage>;
}

export interface Settings {
  gcpProject: string;
  gcpLocation: string;
  model: string;
  summaryModel: string;
  contextTokenBudget: number;
  contextTokenBudgetCeiling: number;
  contextSummarizeThreshold: number;
  contextKeepRecentGroups: number;
  contextMinCompactableTokens: number;
  toolResultMaxChars: number;
  summaryToolResultMaxChars: number;
  contextRefMaxChars: number;
  planBodyMaxChars: number;
  llmMaxCompletionTokens: number;
  turnTokenCeiling: number;
  attachmentImageTokenCost: number;
  pricePromptPerMillionFlash: number;
  priceCompletionPerMillionFlash: number;
  pricePromptPerMillionPro: number;
  priceCompletionPerMillionPro: number;
  spendLimitDailyUsd: number;
  spendLimitWeeklyUsd: number;
  spendLimitMonthlyUsd: number;
}
