import { AGENT_SYSTEM_PROMPT, CHAT_SYSTEM_PROMPT, PLAN_SYSTEM_PROMPT } from "./prompts";
import {
  buildPlanBlock,
  buildSummarizerInput,
  compactionPlan,
  estimateTokens,
  fitGroups,
  groupMessages,
  historyTokenCounts,
  memoryAcceptable,
  projectMessages,
  trimMemory,
  truncateOpeningMessage,
  wrapMemory,
} from "./history";
import { projectTableOfContents, readProjectMarkdown } from "./projectFile";
import { log } from "./log";
import { estimateCostUsd } from "./models";
import { compressionPair } from "./savings";
import { hydrateImages, loadImageData, modelCanReadImages, NO_VISION_MODEL } from "./attachments";
import { createLlmClient } from "./llmClient";
import { describeImages } from "./llm";
import { summaryModelFor, visionModels } from "./providers";
import { routeModel, taskTypeFrom } from "./router";
import { ChatStore, getWorkspaceFolder } from "./store";
import { parseToolArgs } from "./parse";
import { isThinPlanMd, mergePlanUpdate } from "./planQuality";
import { WorkspaceTools } from "./tools";
import type { ChangeTracker } from "./changes";
import type { UsageStore } from "./usageStore";
import type { Attachment, Chat, LlmClient, Mention, Mode, PlanQuestion, Settings, ToolCall, TurnEvent, UserCredential } from "./types";

const MAX_CONSECUTIVE_NUDGES = 2;
const MAX_NUDGES = 8;

export class AgentLoop {
  private credential?: UserCredential;
  private modelIds?: string[];
  private llm?: LlmClient;
  private summaryFailed = false;
  private turnTotalTokens = 0;
  private lastSaved = 0;
  private lastUsed = 0;
  private lastRules = 0;
  private lastTools = 0;
  private lastUser = 0;
  private lastHistoryFull = 0;
  private lastHistorySent = 0;
  private sendImages = false;

  constructor(
    private store: ChatStore,
    private settings: Settings,
    private emit: (event: TurnEvent) => void,
    private tracker?: ChangeTracker,
    private usage?: UsageStore
  ) {}

  useCredential(credential: UserCredential): void {
    this.credential = credential;
    this.llm = createLlmClient(this.settings, credential);
  }

  useModelList(ids: string[]): void {
    this.modelIds = ids;
  }

  async run(
    chat: Chat,
    userContent: string,
    mode: Mode,
    model: string | undefined,
    signal: AbortSignal,
    thinking?: string,
    attachments?: Attachment[],
    mentions?: Mention[],
    titleHint?: string
  ): Promise<void> {
    if (!this.credential || !this.llm) {
      this.emit({ type: "error", error: "Add an API key or cloud login for this account." });
      return;
    }
    const routed = routeModel(mode, userContent, model, this.credential.provider, this.modelIds);
    const resolvedModel = routed.model;
    const llm = this.llm;
    const tools = new WorkspaceTools(this.settings, mode, this.tracker);
    const systemPrompt =
      mode === "chat" ? CHAT_SYSTEM_PROMPT : mode === "plan" ? PLAN_SYSTEM_PROMPT : AGENT_SYSTEM_PROMPT;

    this.emit({ type: "model_selected", model: resolvedModel, reason: routed.reason, automatic: routed.automatic });

    const storedMentions = mentions?.map(({ kind, label, path: mentionPath }) => ({
      kind,
      label,
      path: mentionPath,
    }));
    const userMsg = await this.store.saveMessage(chat.id, {
      role: "user",
      content: userContent,
      attachments: attachments?.length ? attachments : undefined,
      mentions: storedMentions?.length ? storedMentions : undefined,
    });
    await this.tracker?.beginCheckpoint(chat.id, userMsg.seq, chat.plan ?? null, chat.todos ?? null);
    const images = (attachments ?? []).filter((file) => file.kind === "image");
    this.sendImages = images.length > 0 && modelCanReadImages(resolvedModel);
    if (images.length && !this.sendImages) {
      const described = await this.describeAttachedImages(chat.id, userMsg.seq, userContent, images, signal);
      if (!described) {
        return;
      }
    }
    if (userMsg.seq === 0) {
      const source = titleHint?.trim() || userContent;
      const title = source.length > 35 ? `${source.slice(0, 35)}...` : source;
      await this.store.updateChat(chat.id, { title: title.replace(/\n/g, " ").trim() || "New Chat" });
    }

    let emptyRetries = 0;
    let consecutiveNudges = 0;
    let totalNudges = 0;
    let providerRetries = 0;
    let usedToolThisTurn = false;
    for (;;) {
      if (signal.aborted) {
        this.emit({ type: "error", error: "Cancelled" });
        return;
      }
      const latest = await this.store.getChat(chat.id);
      if (!latest) {
        this.emit({ type: "error", error: "Chat not found" });
        return;
      }

      const schemas = tools.schemas();
      const overhead = promptOverhead(systemPrompt, latest);
      const compaction = compactionPlan(latest.messages, latest.summary, this.settings, schemas, false, overhead);
      if (compaction.summarizeMessages.length && compaction.throughSeq != null && !this.summaryFailed) {
        this.emit({ type: "summarizing" });
        const summarized = await this.summarize(latest, compaction.summarizeMessages, compaction.throughSeq, llm, signal, resolvedModel);
        if (summarized === "cancelled" || signal.aborted) {
          this.emit({ type: "error", error: "Cancelled" });
          return;
        }
        if (summarized === "skip") {
          this.summaryFailed = true;
        }
        if (summarized === "ok") {
          this.emit({
            type: "status",
            message: "Summarized earlier messages. Continuing with the compact history.",
          });
        }
      }

      const afterSummary = (await this.store.getChat(chat.id)) ?? latest;
      const promptSource = compactionPlan(
        afterSummary.messages,
        afterSummary.summary,
        this.settings,
        schemas,
        false,
        promptOverhead(systemPrompt, afterSummary)
      ).promptMessages;
      let summaryMsg: Record<string, unknown> | undefined;
      let summaryTokens = 0;
      const planBlock = buildPlanBlock(afterSummary.plan, afterSummary.todos);
      let planMsg: Record<string, unknown> | undefined;
      let planTokens = 0;
      if (planBlock) {
        planMsg = { role: "user", content: planBlock };
        planTokens = estimateTokens([planMsg]);
      }
      const folder = getWorkspaceFolder();
      const projectToc = folder ? projectTableOfContents(readProjectMarkdown(folder.uri.fsPath)) : "";
      let tocMsg: Record<string, unknown> | undefined;
      let tocTokens = 0;
      if (projectToc) {
        tocMsg = { role: "user", content: projectToc };
        tocTokens = estimateTokens([tocMsg]);
      }
      if (afterSummary.summary?.summary_text) {
        summaryMsg = { role: "user", content: wrapMemory(afterSummary.summary.summary_text) };
        summaryTokens = estimateTokens([summaryMsg]);
      }
      const systemTokens = estimateTokens([{ role: "system", content: systemPrompt }]);
      const schemaTokens = estimateTokens([], schemas);
      const projected = projectMessages(truncateOpeningMessage(promptSource), this.settings.toolResultMaxChars);
      if (this.sendImages) {
        hydrateImages(projected);
      }
      const groups = groupMessages(projected);
      const promptBudget = Math.max(1, this.settings.contextTokenBudget - this.settings.llmMaxCompletionTokens);
      const { fitted, elided } = fitGroups(
        groups,
        promptBudget,
        systemTokens,
        summaryTokens,
        planTokens + tocTokens,
        schemaTokens
      );
      if (summaryMsg && elided > 0 && afterSummary.summary?.summary_text) {
        summaryMsg = { role: "user", content: wrapMemory(afterSummary.summary.summary_text, elided) };
      }
      const llmMessages: Array<Record<string, unknown>> = [{ role: "system", content: systemPrompt }];
      if (summaryMsg) {
        llmMessages.push(summaryMsg);
      }
      if (planMsg) {
        llmMessages.push(planMsg);
      }
      if (tocMsg) {
        llmMessages.push(tocMsg);
      }
      for (const g of fitted) {
        llmMessages.push(...g);
      }

      const sentHistory: Array<Record<string, unknown>> = [];
      for (const g of fitted) {
        sentHistory.push(...g);
      }
      if (summaryMsg) {
        sentHistory.push(summaryMsg);
      }
      const counts = historyTokenCounts(afterSummary.messages, sentHistory, this.settings.attachmentImageTokenCost);
      const latestUser = [...promptSource].reverse().find((message) => message.role === "user" && !message.hidden && !message.notice);
      const userTokens = latestUser ? estimateTokens([{ role: "user", content: latestUser.content ?? "" }]) : counts.userTokens;
      this.emitContext(llmMessages, schemas, counts.historyFull, counts.historySent, userTokens);

      let accumulatedText = "";
      let accumulatedCalls: ToolCall[] = [];
      let usageData: {
        total_tokens?: number;
        prompt_tokens?: number;
        completion_tokens?: number;
        cached_tokens?: number;
      } = {};
      let gotResponse = false;
      let providerError = "";

      const forced = forcedToolNames(mode, afterSummary, usedToolThisTurn, schemas);
      const reasoningChoice = !model || model === "auto" ? "low" : thinking;
      try {
        for await (const event of llm.streamChat(llmMessages, schemas, resolvedModel, signal, reasoningChoice, forced)) {
          if (event.type === "thought_delta") {
            this.emit({ type: "thought_delta", text: event.text });
          } else if (event.type === "content_delta") {
            accumulatedText += event.text;
            gotResponse = true;
          } else if (event.type === "tool_calls") {
            accumulatedCalls = event.calls;
            gotResponse = true;
          } else if (event.type === "usage") {
            usageData = event;
          } else if (event.type === "status") {
            this.emit({ type: "status", message: event.message });
          } else if (event.type === "done") {
            accumulatedText = event.text || accumulatedText;
            accumulatedCalls = event.tool_calls?.length ? event.tool_calls : accumulatedCalls;
            usageData = event.usage ?? usageData;
            gotResponse = true;
          } else if (event.type === "error") {
            if (event.error === "Cancelled" || signal.aborted) {
              this.emit({ type: "error", error: "Cancelled" });
              return;
            }
            providerError = event.error;
            break;
          }
        }
      } catch (err) {
        if (signal.aborted) {
          this.emit({ type: "error", error: "Cancelled" });
          return;
        }
        providerError = err instanceof Error ? err.message : String(err);
      }

      if (providerError || !gotResponse) {
        if (signal.aborted) {
          this.emit({ type: "error", error: "Cancelled" });
          return;
        }
        const delay = providerRetryDelay(providerRetries);
        providerRetries += 1;
        this.emit({ type: "status", message: `Provider error. Retrying in ${Math.round(delay / 1000)}s.` });
        if (await waitForRetry(delay, signal)) {
          this.emit({ type: "error", error: "Cancelled" });
          return;
        }
        continue;
      }
      providerRetries = 0;

      if (accumulatedText && !accumulatedCalls.length) {
        this.emit({ type: "content_delta", text: accumulatedText });
      }

      const totalThis = usageData.total_tokens || (usageData.prompt_tokens ?? 0) + (usageData.completion_tokens ?? 0);
      this.turnTotalTokens += totalThis;
      const prompt = usageData.prompt_tokens ?? 0;
      const completion = usageData.completion_tokens ?? 0;
      const taskType = taskTypeFrom(mode, accumulatedCalls);
      const costUsd = estimateCostUsd(this.settings, resolvedModel, prompt, completion);
      const month = await this.usage?.record({
        ts: Date.now(),
        chatId: chat.id,
        model: resolvedModel,
        mode,
        taskType,
        prompt,
        completion,
        cached: usageData.cached_tokens ?? 0,
        saved: this.lastSaved,
        used: this.lastUsed,
        costUsd,
        historyFull: this.lastHistoryFull,
        historySent: this.lastHistorySent,
        kind: "turn",
      });
      this.emit({
        type: "usage",
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: totalThis,
        cached_tokens: usageData.cached_tokens,
        saved: this.lastSaved,
        used: this.lastUsed,
        budget: this.settings.contextTokenBudget,
        costUsd,
        model: resolvedModel,
        taskType,
        month,
        rules_tokens: this.lastRules,
        tools_tokens: this.lastTools,
        user_tokens: this.lastUser,
        history_full: this.lastHistoryFull,
        history_sent: this.lastHistorySent,
      });

      if (!accumulatedCalls.length) {
        const nudge = continuationNudge(mode, afterSummary, usedToolThisTurn, consecutiveNudges, totalNudges);
        if (!accumulatedText.trim()) {
          if (nudge && !signal.aborted) {
            consecutiveNudges += 1;
            totalNudges += 1;
            await this.store.saveMessage(chat.id, { role: "user", content: nudge, hidden: true });
            continue;
          }
          if (emptyRetries < 1) {
            emptyRetries += 1;
            continue;
          }
          const detail = this.credential?.provider === "google"
            ? " Open Output → CodeCook for the raw response, then try again."
            : " Try again, or choose another model.";
          this.emit({
            type: "error",
            error: `The model returned an empty reply.${detail}`,
          });
          return;
        }
        await this.store.saveMessage(chat.id, {
          role: "assistant",
          content: accumulatedText,
          usage: usageData,
        });
        if (nudge && !signal.aborted) {
          consecutiveNudges += 1;
          totalNudges += 1;
          await this.store.saveMessage(chat.id, { role: "user", content: nudge, hidden: true });
          continue;
        }
        this.emit({ type: "done" });
        return;
      }

      for (const call of accumulatedCalls) {
        call.status = "pending";
        call.result = null;
      }
      const assistant = await this.store.saveMessage(chat.id, {
        role: "assistant",
        content: accumulatedText || "",
        tool_calls: accumulatedCalls,
        usage: usageData,
      });

      for (let i = 0; i < accumulatedCalls.length; i++) {
        if (signal.aborted) {
          this.emit({ type: "error", error: "Cancelled" });
          return;
        }
        const call = accumulatedCalls[i];
        const toolName = call.function?.name ?? "";
        const rawArgs = call.function?.arguments ?? "{}";
        await this.store.updateToolCall(chat.id, assistant.seq, i, "running", null);
        this.emit({ type: "tool_call_start", name: toolName, arguments: rawArgs, call_id: call.id });

        let resultText: string;
        let resultOk = false;
        let extra: { todos?: Chat["todos"]; title?: string; overview?: string; plan_md?: string; questions?: PlanQuestion[] } = {};
        try {
          const args = parseToolArgs(rawArgs);
          const result = await tools.execute(toolName, args, signal);
          resultText = result.text;
          resultOk = result.ok;
          extra = { todos: result.todos, title: result.title, overview: result.overview, plan_md: result.plan_md, questions: result.questions };
        } catch (err) {
          resultText = err instanceof Error ? err.message : String(err);
          resultOk = false;
        }

        await this.store.updateToolCall(chat.id, assistant.seq, i, resultOk ? "completed" : "error", resultText);
        this.emit({
          type: "tool_call_result",
          name: toolName,
          result: resultText.slice(0, 2000),
          call_id: call.id,
          ok: resultOk,
        });
        await this.store.saveMessage(chat.id, {
          role: "tool",
          content: resultText,
          tool_call_id: call.id,
        });
        if (signal.aborted || resultText === "Error: Cancelled") {
          this.emit({ type: "error", error: "Cancelled" });
          return;
        }

        if (toolName === "ask_question" && resultOk && extra.questions?.length) {
          if (!latestVisibleUser(afterSummary).includes("Here are my choices:")) {
            this.emit({ type: "questions", questions: extra.questions });
            this.emit({ type: "done" });
            return;
          }
        } else {
          usedToolThisTurn = true;
        }
        if (toolName === "todo_write" && resultOk && extra.todos) {
          await this.store.saveTodos(chat.id, extra.todos);
          const planStatus = mode === "plan" ? "draft" : "approved";
          const current = await this.store.getChat(chat.id);
          const merged = extra.title || extra.plan_md
            ? mergePlanUpdate(current?.plan, { title: extra.title, overview: extra.overview, body_md: extra.plan_md }, planStatus)
            : current?.plan;
          if (merged && (extra.title || extra.plan_md)) {
            await this.store.savePlan(chat.id, merged);
          }
          this.emit({
            type: "todos_updated",
            todos: extra.todos,
            plan: merged,
          });
          if (mode === "plan" && merged?.body_md && !isThinPlanMd(merged.body_md)) {
            this.emit({ type: "done" });
            return;
          }
        }
      }
      consecutiveNudges = 0;
    }
  }

  private emitContext(
    messages: Array<Record<string, unknown>>,
    schemas: ReturnType<WorkspaceTools["schemas"]>,
    historyFull: number,
    historySent: number,
    userTokens: number
  ): void {
    const used = estimateTokens(messages, schemas, this.settings.attachmentImageTokenCost);
    const saved = compressionPair(
      { used, saved: 0, historyFull, historySent },
      this.settings.turnTokenCeiling
    ).saved;
    this.lastUsed = used;
    this.lastSaved = saved;
    this.lastHistoryFull = historyFull;
    this.lastHistorySent = historySent;
    this.lastRules = 0;
    this.lastTools = 0;
    this.lastUser = userTokens;
    const percent = Math.min(100, Math.round((used / this.settings.contextTokenBudget) * 100));
    this.emit({
      type: "context",
      percent,
      label: `${percent}%`,
      used,
      budget: this.settings.contextTokenBudget,
      saved,
      saved_truncation: 0,
      saved_history: saved,
      elided: 0,
      user_tokens: userTokens,
      history_full: historyFull,
      history_sent: historySent,
    });
  }

  private async describeAttachedImages(
    chatId: string,
    seq: number,
    userContent: string,
    images: Attachment[],
    signal: AbortSignal
  ): Promise<boolean> {
    if (signal.aborted) {
      this.emit({ type: "error", error: "Cancelled" });
      return false;
    }
    this.emit({ type: "status", message: "Reading…" });
    const loaded = loadImageData(images);
    if (!loaded.length) {
      this.emit({ type: "error", error: "The image could not be read from temporary storage." });
      return false;
    }
    const description = await describeImages(this.llm!, loaded, signal, visionModels(this.credential?.provider ?? "google", this.modelIds));
    if (signal.aborted) {
      this.emit({ type: "error", error: "Cancelled" });
      return false;
    }
    if (!description) {
      this.emit({ type: "error", error: NO_VISION_MODEL });
      return false;
    }
    const names = images.map((image) => image.name).join(", ");
    await this.store.patchMessage(chatId, seq, {
      content: `${userContent}\n\nImage description (${names}):\n${description}`,
    });
    return true;
  }

  async compactHistory(chat: Chat, signal: AbortSignal): Promise<boolean> {
    if (!chat.messages.length) {
      return false;
    }
    const plan = compactionPlan(chat.messages, chat.summary, this.settings, undefined, true);
    if (!plan.summarizeMessages.length || plan.throughSeq == null) {
      return false;
    }
    if (!this.llm || !this.credential) {
      return false;
    }
    this.emit({ type: "summarizing" });
    const llm = this.llm;
    const before = chat.summary?.summary_count ?? 0;
    try {
      const result = await this.summarize(chat, plan.summarizeMessages, plan.throughSeq, llm, signal, chat.model || this.settings.model);
      if (result !== "ok") {
        return false;
      }
      const latest = await this.store.getChat(chat.id);
      const next = compactionPlan(latest?.messages ?? [], latest?.summary, this.settings, undefined, false);
      const projected = projectMessages(next.promptMessages, this.settings.toolResultMaxChars);
      const sentHistory: Array<Record<string, unknown>> = [];
      if (latest?.summary?.summary_text) {
        sentHistory.push({ role: "user", content: latest.summary.summary_text });
      }
      sentHistory.push(...projected);
      const counts = historyTokenCounts(latest?.messages ?? [], sentHistory, this.settings.attachmentImageTokenCost);
      this.emitContext(sentHistory, [], counts.historyFull, counts.historySent, counts.userTokens);
      return (latest?.summary?.summary_count ?? 0) > before;
    } catch {
      return false;
    }
  }

  private async summarize(
    chat: Chat,
    older: Chat["messages"],
    throughSeq: number,
    llm: LlmClient,
    signal: AbortSignal,
    chatModel?: string
  ): Promise<"ok" | "skip" | "cancelled"> {
    if (signal.aborted) {
      return "cancelled";
    }
    try {
      const prior = chat.summary?.summary_text;
      const priorCount = chat.summary?.summary_count ?? 0;
      const picked = summaryModelFor(this.settings, this.credential?.provider ?? "google", this.modelIds, chatModel);
      const summaryModel = picked.id;
      log(`Summary model ${summaryModel} (${picked.reason}).`);
      const input = buildSummarizerInput(
        older,
        prior,
        priorCount,
        this.settings.summaryToolResultMaxChars,
        this.settings.contextRefMaxChars
      );
      let summaryText = "";
      let summaryPrompt = 0;
      let summaryCompletion = 0;
      let summaryCached = 0;
      for await (const event of llm.streamChat(input, undefined, summaryModel, signal)) {
        if (event.type === "content_delta") {
          summaryText += event.text;
        } else if (event.type === "usage") {
          summaryPrompt = event.prompt_tokens;
          summaryCompletion = event.completion_tokens;
          summaryCached = event.cached_tokens;
        } else if (event.type === "done") {
          summaryText = event.text || summaryText;
          summaryPrompt = event.usage?.prompt_tokens ?? summaryPrompt;
          summaryCompletion = event.usage?.completion_tokens ?? summaryCompletion;
          summaryCached = event.usage?.cached_tokens ?? summaryCached;
        } else if (event.type === "error" && event.error === "Cancelled") {
          return "cancelled";
        }
      }
      if (signal.aborted) {
        return "cancelled";
      }
      if (summaryPrompt || summaryCompletion) {
        const summaryCost = estimateCostUsd(this.settings, summaryModel, summaryPrompt, summaryCompletion);
        await this.usage?.record({
          ts: Date.now(),
          chatId: chat.id,
          model: summaryModel,
          mode: chat.mode,
          taskType: "chat",
          prompt: summaryPrompt,
          completion: summaryCompletion,
          cached: summaryCached,
          saved: 0,
          used: summaryPrompt + summaryCompletion,
          costUsd: summaryCost,
          historyFull: 0,
          historySent: 0,
          kind: "summary",
        });
      }
      summaryText = summaryText.trim();
      if (!memoryAcceptable(summaryText)) {
        return "skip";
      }
      summaryText = trimMemory(summaryText);
      await this.store.saveSummary(chat.id, {
        summary_text: summaryText,
        through_seq: throughSeq,
        summary_count: priorCount + 1,
      });
      await this.store.saveMessage(chat.id, {
        role: "user",
        content: "Summarized earlier messages. Continuing with the compact history.",
        notice: true,
        hidden: true,
      });
      return "ok";
    } catch {
      if (signal.aborted) {
        return "cancelled";
      }
      return "skip";
    }
  }
}

function promptOverhead(systemPrompt: string, chat: Chat): number {
  const planBlock = buildPlanBlock(chat.plan, chat.todos);
  return (
    estimateTokens([{ role: "system", content: systemPrompt }]) +
    (planBlock ? estimateTokens([{ role: "user", content: planBlock }]) : 0)
  );
}

function planWrittenAfterAnswers(chat: Chat): boolean {
  const messages = chat.messages;
  let answerAt = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "user" && !message.hidden && (message.content || "").includes("Here are my choices:")) {
      answerAt = i;
      break;
    }
  }
  if (answerAt < 0) {
    return Boolean(chat.plan?.body_md?.trim());
  }
  for (let i = answerAt + 1; i < messages.length; i++) {
    const message = messages[i];
    if (
      message.role === "assistant" &&
      message.tool_calls?.some((call) => call.function?.name === "todo_write" && call.status === "completed")
    ) {
      return true;
    }
  }
  return false;
}

function forcedToolNames(
  mode: Mode,
  chat: Chat,
  usedToolThisTurn: boolean,
  schemas: ReturnType<WorkspaceTools["schemas"]>
): string[] | undefined {
  if (mode === "chat") {
    return undefined;
  }
  const user = latestVisibleUser(chat);
  const answered = user.includes("Here are my choices:");
  const building = user.includes("Implement the approved plan.");
  if (mode === "plan") {
    return answered && !planWrittenAfterAnswers(chat) ? ["todo_write"] : undefined;
  }
  if (usedToolThisTurn || (!answered && !building)) {
    return undefined;
  }
  const names = schemas.map((schema) => schema.function.name).filter((name) => name !== "ask_question");
  return names.length ? names : undefined;
}

function latestVisibleUser(chat: Chat): string {
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    const message = chat.messages[i];
    if (message.role === "user" && !message.hidden && !message.notice) {
      return message.content || "";
    }
  }
  return "";
}

function continuationNudge(
  mode: Mode,
  chat: Chat,
  usedToolThisTurn: boolean,
  consecutive: number,
  total: number
): string | undefined {
  if (mode === "chat" || consecutive >= MAX_CONSECUTIVE_NUDGES || total >= MAX_NUDGES) {
    return undefined;
  }
  const user = latestVisibleUser(chat);
  const answered = user.includes("Here are my choices:");
  const building = user.includes("Implement the approved plan.");
  const open = (chat.todos || []).some((todo) => todo.status === "pending" || todo.status === "in_progress");
  if (mode === "plan") {
    if (answered && !planWrittenAfterAnswers(chat)) {
      return "The user already answered. Call todo_write now with the full plan. Do not ask them to continue.";
    }
    return undefined;
  }
  if (open || ((answered || building) && !usedToolThisTurn)) {
    return "Keep going. Use tools for the next unfinished step. Do not ask the user to continue or click Build again.";
  }
  return undefined;
}

function providerRetryDelay(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
}

function waitForRetry(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(false);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(true);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
