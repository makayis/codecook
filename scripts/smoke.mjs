import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const extJs = fs.readFileSync(path.join(here, "../out/extension.js"), "utf8");
assert.match(extJs, /function activate/);
assert.match(extJs, /codecook\.chat/);
assert.match(extJs, /makayis-before/);
assert.match(extJs, /codecook\.openPlan/);
assert.match(extJs, /codecook\.revertAll/);
assert.match(extJs, /type: "usage"/);
assert.match(extJs, /id="mode-btn"/);
assert.match(extJs, /id="mode-menu"/);
assert.match(extJs, /CHAT_SYSTEM_PROMPT|You have no write_file/);
assert.match(extJs, /codecook\.tokens/);
assert.match(extJs, /token-ring/);
assert.doesNotMatch(extJs, /id="btn-plan"/);
assert.match(extJs, /codecook\.savingsReport/);
assert.match(extJs, /Auto-routed to Flash|Auto-routed to Pro/);
assert.match(extJs, /codecook\.summarizeChat/);
assert.match(extJs, />Input</);
assert.match(extJs, />Output</);
assert.match(extJs, />Your message \(tokens\)</);
assert.match(extJs, />Without compression</);
assert.match(extJs, />With compression</);
assert.doesNotMatch(extJs, /Rules \(est\.\)/);
assert.doesNotMatch(extJs, /Tools \(est\.\)/);
assert.doesNotMatch(extJs, /User \(est\.\)/);
assert.match(extJs, /This month/);
assert.match(extJs, /Monthly spend limit/);
assert.match(extJs, /Summarize chat/);
assert.doesNotMatch(extJs, /Context left/);
assert.doesNotMatch(extJs, /This request/);
assert.doesNotMatch(extJs, /Prompt \/ completion/);
assert.match(extJs, /row primary/);
assert.match(extJs, /id="activity"/);
assert.match(extJs, /thought_delta/);
assert.match(extJs, /includeThoughts/);
assert.match(extJs, /gemini-3\.8-flash/);
assert.match(extJs, /id="model-btn"/);
assert.doesNotMatch(extJs, /id="thinking"/);
assert.match(extJs, /thinkingLevel/);
assert.match(extJs, /gemini-3/);
assert.doesNotMatch(extJs, /gemini-3\.8-flash[\s\S]{0,80}thinkingLevel/);
assert.match(extJs, /functionResponse: \{[\s\S]*?id: callId/);
assert.match(extJs, /functionResponse\.response\.result/);
assert.match(extJs, /contextTokenBudget", 25e4/);
assert.match(extJs, /contextSummarizeThreshold", 0\.2/);
assert.match(extJs, /contextMinCompactableTokens", 8e3/);
assert.match(extJs, /project_note/);
assert.match(extJs, /Do not write \.makayis\/project\.md/);
assert.match(extJs, /An error that still fails is important/);
assert.match(extJs, /Summarized earlier messages\. Continuing with the compact history\./);
assert.doesNotMatch(extJs, /Token ceiling reached/);
assert.match(extJs, /Start with tools immediately/);
assert.match(extJs, /ask_question/);
assert.match(extJs, /Call todo_write now with the full plan/);
assert.match(extJs, /hidden: true/);
assert.match(extJs, /allowedFunctionNames/);
assert.match(extJs, /recommended option/);
assert.match(extJs, /substantial 'plan_md'/);
assert.match(extJs, /Vertex quota or free-trial limit/);
assert.match(extJs, /write the files and run the install immediately/);
assert.match(extJs, /taskkill/);
assert.match(extJs, /finished content/);
assert.match(extJs, /almost no visible text/);
assert.match(extJs, /The shell is PowerShell/);
assert.match(extJs, /--vscode-sideBar-background/);
assert.match(extJs, /--vscode-foreground/);
assert.doesNotMatch(extJs, /color-scheme: dark/);
assert.doesNotMatch(extJs, /By task/);
assert.doesNotMatch(extJs, /linear-gradient\(160deg/);
assert.match(extJs, /img-src data:/);
assert.match(extJs, /id="btn-attach"/);
assert.match(extJs, /read_attachment/);
assert.match(extJs, /inlineData/);
assert.match(extJs, /No checked model can read images\./);
assert.match(extJs, /Save it as PDF or \.docx/);
assert.match(extJs, /Call read_attachment on each path before answering/);
const chatJs = fs.readFileSync(path.join(here, "../media/chat.js"), "utf8");
assert.match(chatJs, /clipboardData/);
assert.match(chatJs, /is larger than 8 MB/);
assert.match(chatJs, /docx/);
assert.match(extJs, /accept="[^"]*\.docx/);
assert.match(chatJs, /tool cmd/);
assert.match(chatJs, /createElement\("details"\)/);
assert.match(chatJs, /textContent = "Restore"/);
assert.match(chatJs, /openLink/);
assert.match(chatJs, /data-external/);
const renderSrc = chatJs.slice(chatJs.indexOf("function escapeHtml"), chatJs.indexOf("function append"));
const renderMarkdown = new Function(`${renderSrc}\nreturn renderMarkdown;`)();
const formatted = renderMarkdown(
  "See https://example.com/docs.\n\n1. Run tests\n2. Check output\n\n- alpha\n* beta\n\n**bold** and `https://example.com` plus `<div>`\n\n[Docs](https://example.com/a)\n\n```html\n<div class=\"x\">hi</div>\n```\n\n[bad](javascript:alert(1))\n"
);
assert.match(formatted, /<p>See <a href="https:\/\/example\.com\/docs" data-external="1">https:\/\/example\.com\/docs<\/a>\.<\/p>/);
assert.match(formatted, /<ol><li>Run tests<\/li><li>Check output<\/li><\/ol>/);
assert.match(formatted, /<ul><li>alpha<\/li><li>beta<\/li><\/ul>/);
assert.match(formatted, /<strong>bold<\/strong>/);
assert.match(formatted, /<code>https:\/\/example\.com<\/code>/);
assert.doesNotMatch(formatted, /<code><a /);
assert.match(formatted, /&lt;div&gt;/);
assert.match(formatted, /class="code-lang">html<\/div><pre><code>&lt;div class="x"&gt;hi&lt;\/div&gt;/);
assert.match(formatted, /<a href="https:\/\/example\.com\/a" data-external="1">Docs<\/a>/);
assert.doesNotMatch(formatted, /href="javascript:/);
const hostile = renderMarkdown('see https://x.com/"onclick=alert(1)');
assert.doesNotMatch(hostile, /<a /);
assert.match(hostile, /onclick/);
const chatCss = fs.readFileSync(path.join(here, "../media/chat.css"), "utf8");
assert.match(chatCss, /\.tool\.cmd\[open\] pre/);
const packageJson = fs.readFileSync(path.join(here, "../package.json"), "utf8");
assert.match(packageJson, /editorHasSelection/);
assert.match(packageJson, /terminalFocus/);
assert.match(packageJson, /codecook\.addSelectionToChat/);
assert.match(packageJson, /codecook\.addTerminalToChat/);
assert.match(packageJson, /codecook\.addFileToChat/);
assert.match(packageJson, /explorer\/context/);
assert.match(chatJs, /mention-menu|mentionQuery/);
assert.match(chatJs, /id: "chat", label: "Chat"/);
assert.match(chatJs, /id: "plan", label: "Plan"/);
assert.match(chatJs, /text\/uri-list/);
assert.match(chatJs, /application\/vnd\.code\.uri-list/);
assert.match(chatJs, /CodeFiles/);
assert.match(chatJs, /dragover/);
assert.match(chatJs, /mentionAck/);
assert.match(extJs, /Highlight terminal text, then choose Add to Chat/);
assert.match(extJs, /openExternal/);

const { resolveWorkspacePath, applyExactEdits, isThinHtml } = require("../out/smoke-tools.js");
const {
  estimateTokens,
  groupMessages,
  fitGroups,
  compactionPlan,
  buildSummarizerInput,
  memoryAcceptable,
  trimMemory,
  truncateOpeningMessage,
  applyProjectNote,
  projectTableOfContents,
  tidyProject,
  writeProjectMarkdown,
  readProjectMarkdown,
  smallRank,
  summaryModelFor,
  parseToolArgs,
  parseVertexStream,
  mergeTextPieces,
  extractJsonArrayObjects,
  routeModel,
  taskTypeFrom,
  selectChatModels,
  pickListedModel,
  enabledModels,
  visionModels,
  classifyProbeFailure,
  reasoningEffort,
  supportsReasoning,
  credentialFor,
  LOCAL_ACCOUNT,
  buildAuthorizeUrl,
  createPkce,
  planUsageGranted,
  verifyIdToken,
  chatGptModelIds,
  parseSseBlocks,
  toChatGptPlan,
  normalizeSaved,
  estimateCostUsd,
  estimateDisplayCostUsd,
  cacheDiscountUsd,
  formatUsd,
  readProviderUsage,
  buildSavingsMarkdown,
  compressionPair,
  sessionSavings,
  forecastSpend,
  periodSnapshots,
  warnLevel,
  isThinPlanMd,
  mergePlanUpdate,
  parseAskQuestions,
  documentText,
  extractDocxText,
  extractPdfText,
  modelCanReadImages,
  readAttachmentFile,
  saveChatAttachment,
  setAttachmentRoot,
  restoreFiles,
  buildMentionBlocks,
  isBinaryMention,
} = require("../out/smoke-logic.js");

const root = path.resolve("C:/tmp/ws");
const inside = resolveWorkspacePath("src/app.ts", root);
assert.ok(inside.replace(/\\/g, "/").endsWith("src/app.ts"));
assert.throws(() => resolveWorkspacePath("../secret.txt", root), /escapes/);
assert.throws(() => resolveWorkspacePath("/etc/passwd", root), /Absolute/);

const edited = applyExactEdits("hello world", "a.txt", [{ old_string: "world", new_string: "there" }]);
assert.equal(edited.ok, true);
assert.equal(edited.modified, "hello there");
assert.equal(edited.replacements, 1);
const crlf = applyExactEdits("hello\r\nworld", "a.txt", [{ old_string: "hello\nworld", new_string: "hello\nthere" }]);
assert.equal(crlf.ok, true);
assert.equal(crlf.modified, "hello\r\nthere");
const numbered = applyExactEdits("hello\nworld", "a.txt", [{ old_string: "     1| hello\n     2| world", new_string: "hello\nthere" }]);
assert.equal(numbered.ok, true);
assert.equal(numbered.modified, "hello\nthere");
assert.equal(isThinHtml("<html><body><!-- Content will go here --></body></html>"), true);
assert.equal(isThinHtml(`<html><body><p>${"Visible page text. ".repeat(8)}</p></body></html>`), false);

const ambiguous = applyExactEdits("aa aa", "a.txt", [{ old_string: "aa", new_string: "bb" }]);
assert.equal(ambiguous.ok, false);

const tokens = estimateTokens([{ role: "user", content: "abcd" }]);
assert.equal(tokens, 1 + 4);

const groups = groupMessages([
  { role: "user", content: "hi" },
  { role: "assistant", content: "", tool_calls: [{ id: "1" }] },
  { role: "tool", content: "ok", tool_call_id: "1" },
]);
assert.equal(groups.length, 2);
assert.equal(groups[1].length, 2);

const fitted = fitGroups(groups, 100000);
assert.equal(fitted.elided, 0);

const long = Array.from({ length: 8 }, (_, i) => ({
  seq: i,
  role: "user",
  content: "x".repeat(400),
}));
const settings = {
  contextTokenBudget: 200,
  contextSummarizeThreshold: 0.8,
  contextKeepRecentGroups: 2,
  contextMinCompactableTokens: 0,
  attachmentImageTokenCost: 0,
};
const packed = compactionPlan(long, undefined, settings, undefined, false);
assert.ok(packed.summarizeMessages.length > 0);
assert.ok(packed.promptMessages.some((message) => message.seq === 0));
assert.ok(packed.promptMessages.some((message) => message.seq === 7));
assert.equal(packed.summarizeMessages.some((message) => message.seq === 7), false);
assert.ok(packed.throughSeq != null && packed.throughSeq < 7);
const applied = compactionPlan(long, { through_seq: packed.throughSeq, summary_text: "kept" }, settings, undefined, false);
assert.equal(applied.summarizeMessages.length, 0);
assert.ok(applied.promptMessages.length < long.length);
assert.equal(applied.promptMessages.some((message) => message.seq === 3), false);
const under = { ...settings, contextTokenBudget: 100000 };
const stale = compactionPlan(long, { through_seq: 7, summary_text: "old" }, under, undefined, false);
assert.equal(stale.promptMessages.length, long.length);
assert.equal(stale.summarizeMessages.length, 0);
const roomy = { ...settings, contextTokenBudget: 1000, contextSummarizeThreshold: 1, contextKeepRecentGroups: 2 };
assert.equal(compactionPlan(long, undefined, roomy, undefined, false, 0).summarizeMessages.length, 0);
assert.ok(compactionPlan(long, undefined, roomy, undefined, false, 200).summarizeMessages.length > 0);

const keptNearTrigger = { ...settings, contextTokenBudget: 1000, contextSummarizeThreshold: 0.2, contextKeepRecentGroups: 2, contextMinCompactableTokens: 1 };
const near = compactionPlan(long, undefined, keptNearTrigger, undefined, false);
assert.equal(near.summarizeMessages.some((message) => message.seq === 6), false);
assert.equal(near.summarizeMessages.some((message) => message.seq === 7), false);
assert.ok(near.summarizeMessages.some((message) => message.seq === 1));

const tooSmallToFold = { ...keptNearTrigger, contextMinCompactableTokens: 8000 };
assert.equal(compactionPlan(long, undefined, tooSmallToFold, undefined, false).summarizeMessages.length, 0);
assert.equal(compactionPlan(long, undefined, tooSmallToFold, undefined, true).summarizeMessages.length, 0);

const wide = Array.from({ length: 8 }, (_, i) => ({ seq: i, role: "user", content: "x".repeat(4000) }));
const tinyBudget = { ...settings, contextTokenBudget: 32000, contextSummarizeThreshold: 0.2, contextKeepRecentGroups: 2, contextMinCompactableTokens: 8000 };
assert.equal(compactionPlan(wide, undefined, tinyBudget, undefined, false).summarizeMessages.length, 0);

const manual = { ...settings, contextTokenBudget: 100000, contextSummarizeThreshold: 0.2, contextKeepRecentGroups: 2, contextMinCompactableTokens: 100 };
assert.ok(compactionPlan(wide, undefined, manual, undefined, true).summarizeMessages.length > 0);
assert.equal(compactionPlan(wide, undefined, manual, undefined, false).summarizeMessages.length, 0);

const paired = [
  { seq: 0, role: "user", content: "x".repeat(4000) },
  { seq: 1, role: "assistant", content: "look", tool_calls: [{ id: "call-1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
  { seq: 2, role: "tool", content: "file", tool_call_id: "call-1" },
  ...Array.from({ length: 6 }, (_, i) => ({ seq: i + 3, role: "user", content: "y".repeat(4000) })),
];
const pairPlan = compactionPlan(paired, undefined, manual, undefined, true);
const pairFold = pairPlan.summarizeMessages;
const pairKeep = pairPlan.promptMessages;
const toolFolded = pairFold.some((message) => message.role === "tool");
const assistantFolded = pairFold.some((message) => message.role === "assistant");
assert.equal(toolFolded, assistantFolded);
if (toolFolded) {
  assert.ok(pairFold.some((message) => message.seq === 1));
  assert.ok(pairFold.some((message) => message.seq === 2));
} else {
  assert.ok(pairKeep.some((message) => message.seq === 1));
  assert.ok(pairKeep.some((message) => message.seq === 2));
}

let rolling = wide.map((message) => ({ ...message }));
let cursor = 0;
for (let pass = 0; pass < 3; pass++) {
  const fold = compactionPlan(rolling, cursor ? { through_seq: cursor, summary_text: "memory" } : undefined, manual, undefined, true);
  assert.ok(fold.throughSeq != null && fold.throughSeq > cursor);
  assert.ok(fold.promptMessages.some((message) => message.seq === 0));
  assert.equal(fold.summarizeMessages.some((message) => message.seq === rolling[rolling.length - 1].seq), false);
  const assistant = fold.summarizeMessages.find((message) => message.role === "assistant");
  if (assistant) {
    const ids = new Set((assistant.tool_calls ?? []).map((call) => call.id));
    for (const message of fold.summarizeMessages) {
      if (message.role === "tool") {
        assert.ok(ids.has(message.tool_call_id));
      }
    }
  }
  cursor = fold.throughSeq;
  const nextSeq = rolling[rolling.length - 1].seq + 1;
  rolling = rolling.concat(Array.from({ length: 4 }, (_, i) => ({ seq: nextSeq + i, role: "user", content: "z".repeat(4000) })));
}

const summaryInput = buildSummarizerInput(
  [
    { seq: 0, role: "user", content: "u".repeat(3000), hidden: false },
    { seq: 1, role: "user", content: "Keep going. Use tools.", hidden: true },
    {
      seq: 2,
      role: "assistant",
      content: "wrote it",
      tool_calls: [{ id: "w", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "src/app.ts", content: "SECRET_BODY" }) } }],
    },
    { seq: 3, role: "tool", content: "t".repeat(5000), tool_call_id: "w" },
  ],
  undefined,
  0,
  1200,
  16000
);
const summaryUser = String(summaryInput[1].content);
assert.ok(summaryUser.includes("u".repeat(3000)));
assert.equal(summaryUser.includes("Keep going"), false);
assert.ok(summaryUser.includes("src/app.ts"));
assert.equal(summaryUser.includes("SECRET_BODY"), false);
assert.ok(summaryUser.includes("[... truncated"));
assert.ok(String(summaryInput[0].content).includes("Do not write .makayis/project.md"));

assert.equal(memoryAcceptable("GOAL\nship\nUSER_REQUIREMENTS\nnone"), false);
const fullMemory = [
  "GOAL",
  "ship the app",
  "USER_REQUIREMENTS",
  "keep tests",
  "DECISIONS",
  "use typescript",
  "FILES",
  "src/app.ts does the work",
  "IMPORTANT_IDENTIFIERS",
  "port 3000",
  "RUNNING_COMMANDS",
  "npm test",
  "KNOWN_FAILURES_DO_NOT_REPEAT",
  "do not retry the old flag",
  "OPEN_WORK",
  "z".repeat(20000),
].join("\n");
assert.equal(memoryAcceptable(fullMemory), true);
const trimmed = trimMemory(fullMemory);
assert.ok(trimmed.includes("ship the app"));
assert.ok(trimmed.includes("keep tests"));
assert.ok(estimateTokens([{ role: "user", content: trimmed }]) <= 4000);

const opened = truncateOpeningMessage([{ seq: 0, role: "user", content: "q".repeat(9000) }, { seq: 1, role: "user", content: "later" }]);
assert.ok(opened[0].content.length < 9000);
assert.equal(opened[1].content, "later");

const summaryChoice = { summaryModel: "gemini-2.5-flash", model: "gemini-3.1-pro-preview" };
assert.equal(summaryModelFor(summaryChoice, "google", ["gemini-2.5-flash", "gemini-3.1-pro-preview"]).reason, "setting");
assert.equal(summaryModelFor({ summaryModel: "gemini-2.5-flash", model: "gpt-4.1" }, "openai", ["gpt-4.1", "gpt-4.1-mini"]).id, "gpt-4.1-mini");
assert.equal(summaryModelFor({ summaryModel: "missing-flash", model: "gpt-4.1" }, "openai", ["gpt-4o", "gpt-4o-mini"]).reason, "ranked");
assert.equal(smallRank("gemini-2.5-pro"), -1);
assert.equal(smallRank("gemini-2.5-flash-lite") > smallRank("gemini-2.5-flash"), true);
const proOnly = summaryModelFor(summaryChoice, "google", ["gemini-3.1-pro-preview"], "gemini-3.1-pro-preview");
assert.equal(proOnly.id, "gemini-3.1-pro-preview");
assert.equal(proOnly.reason, "fallback-chat-model");
const tinyWindow = summaryModelFor(summaryChoice, "google", ["gemini-2.5-flash"], "gemini-3.1-pro-preview", { "gemini-2.5-flash": 1000 });
assert.equal(tinyWindow.reason, "fallback-chat-model");

assert.equal(projectTableOfContents(""), "");
const noted = applyProjectNote("", "DECISIONS", "add", "use typescript", "", new Date("2026-10-03T00:00:00Z"));
assert.equal(noted.error, undefined);
const withFile = applyProjectNote(noted.markdown, "FILES", "add", "src/app.ts renders the page", "", new Date("2026-10-03T00:00:00Z"));
assert.ok(withFile.markdown.includes("use typescript"));
assert.ok(withFile.markdown.includes("src/app.ts renders the page"));
const replaced = applyProjectNote(withFile.markdown, "DECISIONS", "replace", "use javascript", "use typescript", new Date("2026-10-04T00:00:00Z"));
assert.ok(replaced.markdown.includes("use javascript"));
assert.equal(replaced.markdown.includes("use typescript"), false);
assert.ok(replaced.markdown.includes("src/app.ts renders the page"));
const second = applyProjectNote(replaced.markdown, "FILES", "add", "SECOND_FACT_ONLY_IN_FILE", "", new Date("2026-10-05T00:00:00Z"));
const toc = projectTableOfContents(second.markdown);
assert.ok(toc.includes("DECISIONS"));
assert.equal(toc.includes("SECOND_FACT_ONLY_IN_FILE"), false);
assert.equal(toc.includes(second.markdown), false);
const secret = applyProjectNote(second.markdown, "IMPORTANT_IDENTIFIERS", "add", "api_key=super-secret-value");
assert.ok(secret.error);
assert.equal(secret.markdown, second.markdown);
const bulky = applyProjectNote("", "FILES", "add", "f".repeat(5000));
assert.ok(bulky.error);
const fat = `## FILES\n\n- 2026-10-01 | ${"a".repeat(3000)}\n- 2026-10-02 | ${"b".repeat(3000)}\n`;
const tidied = tidyProject(fat, "FILES");
assert.equal(tidied.includes("a".repeat(100)), false);
assert.ok(tidied.includes("b".repeat(100)));
const noteDir = fs.mkdtempSync(path.join(os.tmpdir(), "makayis-notes-"));
writeProjectMarkdown(noteDir, second.markdown);
assert.equal(fs.readFileSync(path.join(noteDir, ".makayis", ".gitignore"), "utf8").includes("*"), true);
assert.equal(readProjectMarkdown(noteDir), second.markdown);
assert.equal(projectTableOfContents(readProjectMarkdown(path.join(noteDir, "missing"))), "");

const args = parseToolArgs('{"path":"src/a.ts"}');
assert.equal(args.path, "src/a.ts");

const jsonArray = parseVertexStream(
  '[{"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}]'
);
assert.equal(jsonArray.length, 1);

const sse = parseVertexStream(
  'data: {"candidates":[{"content":{"parts":[{"text":"Hi"}]}}]}\n\n'
);
assert.equal(sse.length, 1);
assert.equal(mergeTextPieces(["Hello! It looks", "Hello! It looks like you opened an empty folder."]), "Hello! It looks like you opened an empty folder.");
const partialArray = extractJsonArrayObjects('[{"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]},{"candidates":');
assert.equal(partialArray.length, 1);

const flash = routeModel("chat", "what is this function?");
assert.equal(flash.automatic, true);
assert.match(flash.model, /flash/);
const pro = routeModel("agent", "implement a login form");
assert.match(pro.model, /pro/);
assert.equal(routeModel("chat", "hi", "gemini-2.5-flash").automatic, false);
const other = routeModel("agent", "implement a login form", "gemini-3.1-pro-preview", "openai");
assert.doesNotMatch(other.model, /gemini/);
assert.match(other.model, /gpt/);
assert.equal(taskTypeFrom("chat", []), "chat");
assert.equal(taskTypeFrom("agent", [{ function: { name: "write_file" } }]), "generate");
assert.equal(taskTypeFrom("agent", [{ function: { name: "edit_file" } }]), "refactor");

const rates = {
  pricePromptPerMillionFlash: 0.15,
  priceCompletionPerMillionFlash: 0.6,
  pricePromptPerMillionPro: 1.25,
  priceCompletionPerMillionPro: 10,
};
assert.equal(estimateCostUsd(rates, "gemini-2.5-flash", 1_000_000, 0), 0.15);
assert.equal(estimateCostUsd(rates, "gpt-4.1", 1_000_000, 0), 2);
const flashCached = estimateDisplayCostUsd(rates, "gemini-2.5-flash", 1_000_000, 0, 1_000_000);
assert.ok(flashCached < estimateCostUsd(rates, "gemini-2.5-flash", 1_000_000, 0));
assert.equal(flashCached, 0.0375);
const gptCached = estimateDisplayCostUsd(rates, "gpt-4.1", 1_000_000, 0, 500_000);
assert.ok(gptCached < estimateCostUsd(rates, "gpt-4.1", 1_000_000, 0));
assert.equal(gptCached, 1.5);
assert.equal(estimateDisplayCostUsd(rates, "claude-sonnet-4", 1_000_000, 0, 1_000_000), 0.3);
const openaiUsage = readProviderUsage("openai", {
  prompt_tokens: 100,
  completion_tokens: 10,
  prompt_tokens_details: { cached_tokens: 40 },
});
assert.equal(openaiUsage.prompt_tokens, 100);
assert.equal(openaiUsage.cached_tokens, 40);
const claudeUsage = readProviderUsage("anthropic", {
  input_tokens: 20,
  output_tokens: 5,
  cache_read_input_tokens: 80,
  cache_creation_input_tokens: 10,
});
assert.equal(claudeUsage.cached_tokens, 80);
assert.equal(claudeUsage.prompt_tokens, 110);
assert.equal(cacheDiscountUsd(rates, "gemini-2.5-flash", 1_000_000, 1_000_000), 0.1125);
assert.equal(formatUsd(0), "$0.00");
assert.equal(formatUsd(0.06), "$0.06");
assert.equal(formatUsd(200), "$200");
assert.equal(formatUsd(1.5), "$1.50");
assert.equal(formatUsd(0.0004), "$0.0004");
assert.equal(formatUsd(0.00001), "<$0.0001");
assert.equal(credentialFor(null), null);
assert.equal(credentialFor({ provider: "openai", source: "api-key", apiKey: "sk-admin" }).provider, "openai");
assert.equal(LOCAL_ACCOUNT.id, "local:default");
assert.equal(LOCAL_ACCOUNT.provider, "local");
assert.match(extJs, /id="btn-enter"/);
assert.match(extJs, />Enter</);
assert.match(chatJs, /enterApp/);
assert.doesNotMatch(extJs, /Continue with Google/);
assert.doesNotMatch(extJs, /Continue with GitHub/);
assert.doesNotMatch(chatJs, /signInGoogle/);
assert.doesNotMatch(chatJs, /signInGitHub/);
assert.doesNotMatch(packageJson, /googleClientId/);
assert.doesNotMatch(packageJson, /githubClientId/);
assert.doesNotMatch(extJs, /id="login-form"/);
assert.doesNotMatch(extJs, /id="add-user-box"/);
const listed = selectChatModels("openai", ["gpt-4o", "gpt-4.1", "text-embedding-3-small", "whisper-1", "o3", "dall-e-3", "o4-mini-deep-research", "gpt-live-1"]);
assert.deepEqual(listed.map((item) => item.id), ["gpt-4.1", "gpt-4o", "o3"]);
assert.deepEqual(selectChatModels("openai", ["custom-chat-1", "babbage-002", "davinci-002", "sora-1", "text-embedding-3-small"]).map((item) => item.id), ["custom-chat-1"]);
assert.deepEqual(selectChatModels("google", ["gemini-4-argon", "imagen-3", "gemini-embedding-001"]).map((item) => item.id), ["gemini-4-argon"]);
assert.deepEqual(enabledModels(["a", "b", "c"], ["c", "b", "z"]), ["c", "b"]);
assert.deepEqual(enabledModels(["a"], []), []);
assert.deepEqual(visionModels("google", ["gpt-4o"]), []);
assert.deepEqual(visionModels("google", ["gemini-2.5-flash", "gpt-4o"]), ["gemini-2.5-flash"]);
assert.equal(classifyProbeFailure("LLM API error: HTTP 400: no", false, false), "drop");
assert.equal(classifyProbeFailure("LLM API error: HTTP 404: no", false, false), "drop");
assert.equal(classifyProbeFailure("LLM API error: HTTP 429: no", false, false), "retry");
assert.equal(classifyProbeFailure("LLM API error: HTTP 500: no", false, false), "retry");
assert.equal(classifyProbeFailure("Cancelled", true, false), "retry");
assert.equal(classifyProbeFailure("Cancelled", false, true), "aborted");
assert.equal(classifyProbeFailure("LLM API error: HTTP 401: no", false, false), "fatal");
assert.equal(classifyProbeFailure("LLM API error: HTTP 403: Generative Language API has not been used in project X", false, false), "drop");
assert.equal(supportsReasoning("gpt-5.4"), true);
assert.equal(supportsReasoning("gpt-6-astra"), true);
assert.equal(supportsReasoning("o4-mini"), true);
assert.equal(supportsReasoning("o1"), true);
assert.equal(supportsReasoning("gpt-4o"), false);
assert.equal(supportsReasoning("gemini-3.1-pro-preview"), false);
assert.equal(reasoningEffort("gpt-5.4", "high"), "high");
assert.equal(reasoningEffort("gpt-5.4", "HIGH"), "high");
assert.equal(reasoningEffort("gpt-5.4", "off"), "none");
assert.equal(reasoningEffort("o4-mini", "medium"), "medium");
assert.equal(reasoningEffort("o1", undefined), "low");
assert.equal(reasoningEffort("gpt-4o", "high"), undefined);
assert.match(chatJs, /Reasoning/);
assert.match(chatJs, /did not reply/);
assert.doesNotMatch(extJs, /delete body\.reasoning/);
assert.equal(pickListedModel("gpt-4.1", ["gpt-4o", "gpt-4o-mini"], "strong"), "gpt-4o");
assert.equal(pickListedModel("gpt-4.1-mini", ["gpt-4o", "gpt-4o-mini"], "fast"), "gpt-4o-mini");
assert.equal(routeModel("agent", "implement a login form", "auto", "openai", ["gpt-4o", "gpt-4o-mini"]).model, "gpt-4o");
assert.equal(credentialFor({ provider: "google", source: "gcloud", gcpProject: "your-gcp-project-id" }), null);
const savedKey = normalizeSaved({ provider: "openai", source: "api-key", apiKey: "sk-test" });
assert.equal(savedKey.provider, "openai");
assert.equal(credentialFor(savedKey).gcpProject, undefined);
const planBody = toChatGptPlan(
  [
    { role: "system", content: "Be brief." },
    { role: "user", content: "Hi" },
  ],
  [{ type: "function", function: { name: "read_file", description: "Read", parameters: { type: "object" } } }],
  ["read_file"],
  "gpt-5.4"
);
assert.equal(planBody.store, false);
assert.equal(planBody.stream, true);
assert.equal(planBody.instructions, "Be brief.");
assert.equal(planBody.max_output_tokens, undefined);
assert.equal(planBody.input.some((item) => item.role === "system"), false);
assert.equal(planBody.input[0].type, "additional_tools");
assert.equal(planBody.input[0].tools[0].name, "functions");
assert.equal(planBody.tool_choice.name, "read_file");
assert.deepEqual(
  chatGptModelIds({ models: [{ slug: "gpt-5.4", visibility: "list" }, { slug: "hidden", visibility: "hidden" }] }),
  ["gpt-5.4"]
);
const sseBlocks = parseSseBlocks('event: response.completed\ndata: {"ok":true}\n\npartial');
assert.equal(sseBlocks.events[0].event, "response.completed");
assert.equal(sseBlocks.events[0].data, '{"ok":true}');
assert.equal(sseBlocks.rest, "partial");
const firstLogin = new URL(buildAuthorizeUrl({
  redirectUri: "http://127.0.0.1:1455/auth/callback",
  state: "s",
  nonce: "n",
  challenge: "c",
  hostId: "urn:uuid:11111111-1111-4111-8111-111111111111",
}));
assert.equal(firstLogin.searchParams.get("client_id"), "dynamic_agent_client");
assert.equal(firstLogin.searchParams.get("agent_name_hint"), "Makayis");
assert.equal(firstLogin.searchParams.get("redirect_uri"), "http://127.0.0.1:1455/auth/callback");
assert.match(firstLogin.searchParams.get("scope") || "", /chatgpt\.tokens\.use\.direct/);
const savedLogin = new URL(buildAuthorizeUrl({
  redirectUri: "http://127.0.0.1:1455/auth/callback",
  state: "s",
  nonce: "n",
  challenge: "c",
  hostId: "urn:uuid:11111111-1111-4111-8111-111111111111",
  previous: { clientId: "oaiapp_saved", idToken: "hint", email: "a@b.c" },
}));
assert.equal(savedLogin.searchParams.get("client_id"), "oaiapp_saved");
assert.equal(savedLogin.searchParams.get("agent_name_hint"), null);
const pkce = createPkce();
assert.ok(pkce.verifier);
assert.notEqual(pkce.challenge, pkce.verifier);
assert.equal(planUsageGranted(["openid", "chatgpt.tokens.use.direct"]), true);
assert.equal(planUsageGranted(["openid"]), false);
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" });
jwk.kid = "k1";
const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" })).toString("base64url");
const payload = Buffer.from(JSON.stringify({
  iss: "https://auth.openai.com",
  aud: "oaiapp_test",
  exp: Math.floor(Date.now() / 1000) + 600,
  nonce: "nonce-1",
  sub: "user-1",
  email: "a@b.c",
})).toString("base64url");
const signed = `${header}.${payload}`;
const token = `${signed}.${createSign("RSA-SHA256").update(signed).sign(privateKey).toString("base64url")}`;
assert.deepEqual(verifyIdToken(token, [jwk], { clientId: "oaiapp_test", nonce: "nonce-1" }), { sub: "user-1", email: "a@b.c" });
assert.throws(() => verifyIdToken(token, [jwk], { clientId: "oaiapp_test", nonce: "other" }), /did not match/);
const resourcePayload = Buffer.from(JSON.stringify({
  iss: "https://auth.openai.com",
  aud: "https://api.openai.com/v1",
  client_id: "oaiapp_test",
  exp: Math.floor(Date.now() / 1000) + 600,
  nonce: "nonce-1",
  sub: "user-1",
  email: "a@b.c",
})).toString("base64url");
const resourceSigned = `${header}.${resourcePayload}`;
const resourceToken = `${resourceSigned}.${createSign("RSA-SHA256").update(resourceSigned).sign(privateKey).toString("base64url")}`;
assert.equal(verifyIdToken(resourceToken, [jwk], { clientId: "oaiapp_test", nonce: "nonce-1" }).sub, "user-1");
const planCred = credentialFor({
  provider: "openai",
  source: "chatgpt-plan",
  chatgpt: {
    subject: "user-1",
    clientId: "oaiapp_test",
    hostId: "urn:uuid:1",
    accessToken: "tok",
    scopes: ["chatgpt.tokens.use.direct"],
  },
});
assert.equal(planCred.source, "chatgpt-plan");
assert.equal(planCred.apiKey, "tok");
assert.equal(credentialFor({
  provider: "openai",
  source: "chatgpt-plan",
  chatgpt: { subject: "user-1", clientId: "oaiapp_test", hostId: "urn:uuid:1", scopes: ["openid"] },
}), null);
const report = buildSavingsMarkdown(
  [{ ts: Date.now(), chatId: "c", model: "gemini-2.5-flash", mode: "chat", taskType: "chat", prompt: 100, completion: 20, cached: 0, saved: 80, used: 40, costUsd: 0.001 }],
  [],
  rates
);
assert.match(report, /Without compression/);
assert.match(report, /With compression/);
assert.match(report, /Tokens saved/);
const turn = (used, historyFull, historySent, saved) => ({
  ts: Date.now(),
  chatId: "c",
  model: "gemini-2.5-flash",
  mode: "chat",
  taskType: "chat",
  prompt: used,
  completion: 20,
  cached: 0,
  saved,
  used,
  costUsd: 0.001,
  historyFull,
  historySent,
  kind: "turn",
});
const beforeSummary = turn(800_000, 800_000, 800_000, 0);
const afterSummary = turn(15_000, 800_000, 12_000, 788_000);
const summaryCall = {
  ts: Date.now(),
  chatId: "c",
  model: "gemini-2.5-flash",
  mode: "chat",
  taskType: "chat",
  prompt: 1000,
  completion: 200,
  cached: 0,
  saved: 0,
  used: 1200,
  costUsd: 0.01,
  historyFull: 0,
  historySent: 0,
  kind: "summary",
};
const capped = { ...rates, turnTokenCeiling: 1_000_000 };
const afterPair = compressionPair(afterSummary, capped.turnTokenCeiling);
assert.equal(afterPair.without, 803_000);
assert.equal(afterPair.with, 15_000);
assert.equal(afterPair.saved, afterPair.without - afterPair.with);
const overWindow = compressionPair(
  { used: 15_000, saved: 0, historyFull: 2_000_000, historySent: 12_000 },
  1_000_000
);
assert.equal(overWindow.without, 1_000_000);
assert.equal(overWindow.saved, 985_000);
assert.ok(afterPair.with < beforeSummary.used);
const doubled = sessionSavings([afterSummary, afterSummary], capped);
assert.equal(doubled.savedTokens, afterPair.saved);
assert.equal(doubled.savedTokens, 788_000);
const withSummary = sessionSavings([beforeSummary, summaryCall, afterSummary], capped);
assert.equal(withSummary.savedTokens, afterPair.saved);
assert.equal(withSummary.summaries, 1);
const gross = estimateCostUsd(capped, "gemini-2.5-flash", afterPair.saved, 0);
assert.ok(Math.abs(withSummary.savedUsd - (gross - 0.01)) < 1e-9);

const start = Date.UTC(2026, 8, 1);
const mid = Date.UTC(2026, 8, 16);
const end = Date.UTC(2026, 9, 1);
assert.ok(Math.abs(forecastSpend(0.04, start, end, mid) - 0.08) < 0.01);
assert.equal(warnLevel(79), 0);
assert.equal(warnLevel(80), 80);
assert.equal(warnLevel(100), 100);
const snaps = periodSnapshots(
  [{ ts: Date.now(), chatId: "c", model: "x", mode: "chat", taskType: "chat", prompt: 1, completion: 0, cached: 0, saved: 0, used: 1, costUsd: 0.5 }],
  { spendLimitDailyUsd: 1, spendLimitWeeklyUsd: 0, spendLimitMonthlyUsd: 10 }
);
assert.equal(snaps.length, 3);
assert.equal(snaps[0].limit, 1);
assert.ok(snaps[0].left != null && snaps[0].left <= 1);

assert.equal(isThinPlanMd("short"), true);
assert.equal(isThinPlanMd(`${"# Overview\n"}${"x".repeat(800)}`), false);
const longPlan = `# Overview\n${"x".repeat(2000)}`;
const shorterPlan = `# Overview\n${"y".repeat(900)}`;
const keptBody = mergePlanUpdate(
  { title: "Old", overview: "Old overview", body_md: longPlan, status: "draft" },
  { title: "New", overview: "", body_md: shorterPlan },
  "draft"
);
assert.equal(keptBody.body_md, longPlan);
assert.equal(keptBody.title, "New");
assert.equal(keptBody.overview, "Old overview");
const missingBody = mergePlanUpdate(
  { title: "Old", overview: "Old overview", body_md: longPlan, status: "draft" },
  { title: "", overview: "", body_md: "" },
  "approved"
);
assert.equal(missingBody.body_md, longPlan);
assert.equal(missingBody.title, "Old");
assert.equal(missingBody.overview, "Old overview");
const asked = parseAskQuestions({
  questions: [
    {
      id: "stack",
      prompt: "Which stack?",
      options: [{ id: "next", label: "Next.js" }, { id: "static", label: "Static HTML" }],
      recommended: "next",
    },
  ],
});
assert.equal(asked.ok, true);
assert.equal(asked.questions[0].recommended, "next");
assert.equal(parseAskQuestions({ questions: [] }).ok, false);

assert.equal(modelCanReadImages("gemini-3.8-flash"), true);
assert.equal(modelCanReadImages("gemini-2.5-flash"), true);
assert.equal(modelCanReadImages("gemini-3.1-pro-preview"), true);
assert.equal(modelCanReadImages("gemini-4-argon"), true);
assert.equal(modelCanReadImages("gemini-2.0-flash"), false);
assert.equal(estimateTokens([{ role: "user", content: "", images: [{ mime: "image/png", data: "aa" }] }], undefined, 1200), 1204);
assert.match(documentText("old.doc", Buffer.from("binary")), /PDF or \.docx/);
assert.equal(documentText("note.txt", Buffer.from("hello text")), "hello text");
assert.equal(documentText("page.html", Buffer.from("<p>Hi</p>")), "<p>Hi</p>");
assert.match(documentText("shot.png", Buffer.from("not-bytes")), /not read as text/);
const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Length 48 >>\nstream\nBT /F1 12 Tf (Hello PDF) Tj ET\nendstream\nendobj\n");
assert.match(extractPdfText(pdf), /Hello PDF/);
const xml = "<?xml version=\"1.0\"?><w:document><w:p><w:t>Hello docx</w:t></w:p></w:document>";
const xmlBuf = Buffer.from(xml);
const nameBuf = Buffer.from("word/document.xml");
const local = Buffer.alloc(30);
local.writeUInt32LE(0x04034b50, 0);
local.writeUInt16LE(0, 8);
local.writeUInt32LE(xmlBuf.length, 18);
local.writeUInt16LE(nameBuf.length, 26);
assert.match(extractDocxText(Buffer.concat([local, nameBuf, xmlBuf])), /Hello docx/);
const deflated = zlib.deflateRawSync(Buffer.from("(Flate PDF) Tj"));
const flateBody = Buffer.concat([
  Buffer.from("stream\n"),
  deflated,
  Buffer.from("\nendstream"),
]);
assert.match(extractPdfText(Buffer.concat([Buffer.from("%PDF-1.4\n"), flateBody])), /Flate PDF/);
const hexPdf = Buffer.from("%PDF-1.4\nstream\n<48656C6C6F> Tj\nendstream\n");
assert.match(extractPdfText(hexPdf), /Hello/);
const widePdf = Buffer.from("%PDF-1.4\nstream\n<00480065006C006C006F> Tj\nendstream\n");
assert.match(extractPdfText(widePdf), /Hello/);
const arrayPdf = Buffer.from("%PDF-1.4\nstream\n[(Hello) 12 (PDF)] TJ\nendstream\n");
assert.match(extractPdfText(arrayPdf), /Hello/);
assert.match(extractPdfText(arrayPdf), /PDF/);
const stalled = Buffer.from(`%PDF-1.4\nstream\n[${"(".repeat(200000)}\nendstream\n`);
const started = Date.now();
extractPdfText(stalled);
assert.ok(Date.now() - started < 1000);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "makayis-attach-"));
setAttachmentRoot(tempRoot);
const saved = saveChatAttachment("chat-1", "note.txt", Buffer.from("alpha"));
assert.match(readAttachmentFile(saved.path), /alpha/);
assert.throws(() => readAttachmentFile("../note.txt"), /temporary folder/);
assert.throws(() => readAttachmentFile(path.join(tempRoot, "note.txt")), /temporary folder/);
const image = saveChatAttachment("chat-1", "shot.png", Buffer.from("png-bytes"));
assert.doesNotMatch(readAttachmentFile(image.path), /png-bytes/);

const checkpoints = [
  { seq: 0, files: [{ fsPath: "a.txt", rel: "a.txt", before: "original", created: false }] },
  { seq: 2, files: [{ fsPath: "a.txt", rel: "a.txt", before: "after request 1", created: false }] },
];
assert.equal(restoreFiles(checkpoints, 2)[0].before, "after request 1");
assert.equal(restoreFiles(checkpoints, 0)[0].before, "original");
const created = [
  { seq: 0, files: [{ fsPath: "b.txt", rel: "b.txt", before: "", created: true }] },
  { seq: 2, files: [{ fsPath: "b.txt", rel: "b.txt", before: "request 1 text", created: false }] },
];
assert.equal(restoreFiles(created, 2)[0].before, "request 1 text");
assert.equal(restoreFiles(created, 2)[0].created, false);
assert.equal(restoreFiles(created, 0)[0].created, true);

const mentioned = buildMentionBlocks(
  [
    { kind: "file", label: "src/app.ts", path: "src/app.ts" },
    { kind: "file", label: "src/app.ts", path: "src/app.ts" },
    { kind: "file", label: "src/open.ts", path: "src/open.ts" },
    { kind: "selection", label: "open.ts:2-4", path: "src/open.ts", text: "selected lines" },
    { kind: "file", label: "shot.png", path: "shot.png" },
    { kind: "terminal", label: "Terminal", text: "npm test" },
  ],
  "src/open.ts",
  (rel) => (rel === "shot.png" ? { text: "", binary: true } : { text: `body of ${rel}`, binary: false }),
  16000
);
assert.match(mentioned, /body of src\/app\.ts/);
assert.equal(mentioned.match(/body of src\/app\.ts/g).length, 1);
assert.doesNotMatch(mentioned, /body of src\/open\.ts/);
assert.match(mentioned, /selected lines/);
assert.match(mentioned, /--- Terminal selection ---/);
assert.match(mentioned, /npm test/);
assert.match(mentioned, /--- Mentioned file: shot\.png ---[\s\S]*shot\.png/);
assert.equal(isBinaryMention("a.png", Buffer.from("no-null")), true);
assert.equal(isBinaryMention("a.ts", Buffer.from("plain")), false);

console.log("Makayis smoke checks passed: activate export, path jail, edit_file, history, stream parse.");
