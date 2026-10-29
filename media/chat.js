const vscode = acquireVsCodeApi();

const chatList = document.getElementById("chat-list");
const btnNew = document.getElementById("btn-new");
const modeBtn = document.getElementById("mode-btn");
const modeMenu = document.getElementById("mode-menu");
const modelBtn = document.getElementById("model-btn");
const modelMenu = document.getElementById("model-menu");
const ringBtn = document.getElementById("token-ring");
const ringEl = document.getElementById("ring");
const messagesEl = document.getElementById("messages");
const activityEl = document.getElementById("activity");
const activityLabel = document.getElementById("activity-label");
const banner = document.getElementById("banner");
const input = document.getElementById("input");
const btnSend = document.getElementById("btn-send");
const btnCancel = document.getElementById("btn-cancel");
const btnAttach = document.getElementById("btn-attach");
const fileInput = document.getElementById("file-attach");
const attachChips = document.getElementById("attach-chips");
const mentionMenu = document.getElementById("mention-menu");
const composer = document.querySelector(".composer");

let running = false;
let streamEl = null;
let selectedModel = "auto";
let selectedMode = "agent";
let selectedThinking = "off";
let modelOptions = [{ id: "auto", label: "Auto" }];
let pending = [];
let pendingMentions = [];
let chipSeq = 0;
let seenChatId = null;
let mentionTimer = null;
let mentionStart = -1;
let mentionQuery = "";
let mentionIndex = 0;
let mentionFiles = [];
const MAX_MENTIONS = 8;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const ATTACHMENT_EXT = /\.(png|jpe?g|webp|gif|pdf|docx|doc|html|htm|txt|md)$/i;
const IMAGE_MIME = ["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"];

function showBanner(text, show) {
  banner.textContent = text || "";
  banner.classList.toggle("hidden", !show);
}

function setActivity(label) {
  const on = Boolean(label);
  activityEl?.classList.toggle("hidden", !on);
  if (activityLabel) {
    activityLabel.textContent = label || "";
  }
}

function setRunning(on) {
  running = on;
  btnSend.classList.toggle("hidden", on);
  btnCancel.classList.toggle("hidden", !on);
  if (!on) {
    setActivity("");
  }
}

function toolPhase(name) {
  if (name === "read_file" || name === "read_attachment" || name === "list_dir") {
    return "Reading";
  }
  if (name === "grep") {
    return "Searching";
  }
  if (name === "write_file" || name === "edit_file") {
    return "Creating";
  }
  if (name === "ask_question") {
    return "Asking";
  }
  return `Calling ${name || "tool"}`;
}

function isEphemeralStatus(text) {
  return /^Thinking/i.test(text) || /^Reading/i.test(text) || /retrying/i.test(text) || /Rate limited/i.test(text);
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderMarkdown(src) {
  const escaped = escapeHtml(String(src).replace(/\r\n/g, "\n"));
  const parts = [];
  let i = 0;
  const fence = /```([A-Za-z0-9_+#-]*)[ \t]*\r?\n([\s\S]*?)```/g;
  let m;
  while ((m = fence.exec(escaped))) {
    parts.push(inline(escaped.slice(i, m.index)));
    parts.push(codeBlock(m[1], m[2]));
    i = m.index + m[0].length;
  }
  parts.push(inline(escaped.slice(i)));
  return parts.join("");
}

function codeBlock(lang, code) {
  const label = lang ? `<div class="code-lang">${lang}</div>` : "";
  return `<div class="code-block">${label}<pre><code>${code}</code></pre></div>`;
}

function safeHref(url) {
  const clean = String(url).replace(/[.,;:!?)]+$/g, "");
  if (!/^https?:\/\//i.test(clean) || /[\s"'<>]/.test(clean)) {
    return "";
  }
  return clean;
}

function formatInline(text) {
  const links = [];
  let out = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (full, label, href) => {
    const safe = safeHref(href);
    if (!safe) {
      return full;
    }
    const token = `\u0000L${links.length}\u0000`;
    links.push(`<a href="${safe}" data-external="1">${label}</a>`);
    return token;
  });
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<]+)/g, (full, lead, url) => {
    const safe = safeHref(url);
    if (!safe) {
      return full;
    }
    return `${lead}<a href="${safe}" data-external="1">${safe}</a>${url.slice(safe.length)}`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  return out.replace(/\u0000L(\d+)\u0000/g, (_, n) => links[Number(n)] || "");
}

function isBlockStart(line) {
  return /^(#{1,3}) .+/.test(line) || /^[-*] .+/.test(line) || /^\d+\. .+/.test(line);
}

function inline(text) {
  const codes = [];
  const held = text.replace(/`([^`]+)`/g, (_, code) => {
    const token = `\u0000C${codes.length}\u0000`;
    codes.push(`<code>${code}</code>`);
    return token;
  });
  const lines = held.split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    const heading = /^(#{1,3}) (.+)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      blocks.push(`<h${level}>${formatInline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }
    if (/^[-*] (.+)$/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*] (.+)$/.test(lines[i])) {
        items.push(`<li>${formatInline(lines[i].replace(/^[-*] /, ""))}</li>`);
        i += 1;
      }
      blocks.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    if (/^\d+\. (.+)$/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\. (.+)$/.test(lines[i])) {
        items.push(`<li>${formatInline(lines[i].replace(/^\d+\. /, ""))}</li>`);
        i += 1;
      }
      blocks.push(`<ol>${items.join("")}</ol>`);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() !== "" && !isBlockStart(lines[i])) {
      para.push(lines[i]);
      i += 1;
    }
    if (!para.length) {
      i += 1;
      continue;
    }
    blocks.push(`<p>${para.map((part) => formatInline(part)).join("<br>")}</p>`);
  }
  return blocks.join("").replace(/\u0000C(\d+)\u0000/g, (_, n) => codes[Number(n)] || "");
}

function append(html, cls) {
  const el = document.createElement("div");
  el.className = `msg ${cls || ""}`;
  el.innerHTML = html;
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return el;
}

function ensureStream() {
  if (!streamEl) {
    streamEl = append(
      '<details class="thought hidden"><summary>Thinking</summary><div class="thought-body"></div></details><div class="answer"></div>',
      "assistant"
    );
  }
  return streamEl;
}

function setRing(percent) {
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  const circ = 97.4;
  if (ringEl) {
    ringEl.style.strokeDasharray = `${(value / 100) * circ} ${circ}`;
  }
  if (ringBtn) {
    ringBtn.classList.toggle("warn", value >= 60 && value < 85);
    ringBtn.classList.toggle("hot", value >= 85);
    ringBtn.title = `${value}% of summarize budget`;
  }
}

function parseQuestions(call) {
  try {
    const args = JSON.parse(call.function?.arguments || "{}");
    return Array.isArray(args.questions) ? args.questions : [];
  } catch {
    return [];
  }
}

function laterUserAnswered(chat, fromIndex) {
  if (!chat?.messages) {
    return false;
  }
  for (let i = fromIndex + 1; i < chat.messages.length; i++) {
    const msg = chat.messages[i];
    if (msg.role === "user" && !msg.hidden) {
      return true;
    }
  }
  return false;
}

function renderQuestions(questions, answered) {
  const wrap = document.createElement("div");
  wrap.className = "questions";
  wrap.innerHTML = "<h3>A few choices before planning</h3>";
  const selected = {};
  const otherFields = new Map();
  questions.forEach((q) => {
    if (q.recommended) {
      selected[q.id] = q.recommended;
    }
  });
  questions.forEach((q) => {
    const block = document.createElement("div");
    block.className = "q-block";
    const prompt = document.createElement("div");
    prompt.className = "q-prompt";
    prompt.textContent = q.prompt || "";
    block.appendChild(prompt);
    const opts = document.createElement("div");
    opts.className = "q-opts";
    (q.options || []).forEach((opt) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "q-opt";
      if (selected[q.id] === opt.id) {
        btn.classList.add("selected");
      }
      btn.disabled = answered;
      const label = document.createElement("span");
      label.textContent = opt.label || opt.id;
      btn.appendChild(label);
      if (q.recommended === opt.id) {
        const rec = document.createElement("span");
        rec.className = "q-rec";
        rec.textContent = "Recommended";
        btn.appendChild(rec);
      }
      btn.addEventListener("click", () => {
        if (answered) {
          return;
        }
        selected[q.id] = opt.id;
        opts.querySelectorAll(".q-opt").forEach((el) => el.classList.remove("selected"));
        btn.classList.add("selected");
        opts.querySelector(".q-other")?.classList.add("hidden");
      });
      opts.appendChild(btn);
    });
    const otherId = "__other";
    const otherBtn = document.createElement("button");
    otherBtn.type = "button";
    otherBtn.className = "q-opt";
    otherBtn.disabled = answered;
    const otherLabel = document.createElement("span");
    otherLabel.textContent = "Other";
    otherBtn.appendChild(otherLabel);
    const otherInput = document.createElement("input");
    otherInput.type = "text";
    otherInput.className = "q-other hidden";
    otherInput.placeholder = "Type your own answer";
    otherInput.disabled = answered;
    otherFields.set(q.id, otherInput);
    otherBtn.addEventListener("click", () => {
      if (answered) {
        return;
      }
      selected[q.id] = otherId;
      opts.querySelectorAll(".q-opt").forEach((el) => el.classList.remove("selected"));
      otherBtn.classList.add("selected");
      otherInput.classList.remove("hidden");
      otherInput.focus();
    });
    opts.append(otherBtn, otherInput);
    block.appendChild(opts);
    wrap.appendChild(block);
  });
  if (!answered) {
    const go = document.createElement("button");
    go.type = "button";
    go.className = "continue";
    go.textContent = "Continue";
    go.addEventListener("click", () => {
      if (running) {
        return;
      }
      const lines = ["Here are my choices:"];
      for (const q of questions) {
        if (selected[q.id] === "__other") {
          const field = otherFields.get(q.id);
          const text = field?.value.trim() || "";
          if (!text) {
            field?.classList.remove("hidden");
            field?.focus();
            return;
          }
          lines.push(`- ${q.prompt}: ${text}`);
          continue;
        }
        const opt = (q.options || []).find((o) => o.id === selected[q.id]);
        if (!opt) {
          return;
        }
        const rec = q.recommended === opt.id ? " (recommended)" : "";
        lines.push(`- ${q.prompt}: ${opt.label}${rec}`);
      }
      append(`<p>${escapeHtml(lines.join("\n"))}</p>`, "user");
      wrap.querySelectorAll("button, input").forEach((el) => {
        el.disabled = true;
      });
      setRunning(true);
      setActivity("Thinking");
      vscode.postMessage({
        type: "send",
        content: lines.join("\n"),
        mode: selectedMode,
        model: selectedModel,
        thinking: effortChoice(),
      });
    });
    for (const field of otherFields.values()) {
      field.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          go.click();
        }
      });
    }
    wrap.appendChild(go);
  }
  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderHistory(chat) {
  messagesEl.innerHTML = "";
  streamEl = null;
  if (!chat || !chat.messages?.length) {
    messagesEl.innerHTML = '<div class="empty">Ask CodeCook to read, edit, or plan work in this folder.</div>';
    return;
  }
  let lastUsage = null;
  for (const msg of chat.messages) {
    if (msg.notice) {
      append(escapeHtml(msg.content || "Summarized earlier messages. Continuing with the compact history."), "status");
      continue;
    }
    if (msg.hidden || /Please proceed with the task\. Use the available tools to make progress/.test(msg.content || "")) {
      continue;
    }
    if (msg.role === "user") {
      const shown = visibleUserText(msg.content || "");
      const names = (msg.attachments || []).map((file) => file.name).filter(Boolean);
      const mentionLabels = (msg.mentions || []).map((mention) => mention.label).filter(Boolean);
      if (!shown && !names.length && !mentionLabels.length) {
        continue;
      }
      const chips = [...mentionLabels, ...names].map((name) => `<span class="chip">${escapeHtml(name)}</span>`).join("");
      const bubble = append(`${chips}<p>${escapeHtml(shown)}</p>`, "user");
      const restore = document.createElement("button");
      restore.type = "button";
      restore.className = "restore";
      restore.textContent = "Restore";
      restore.addEventListener("click", () => {
        if (running) {
          return;
        }
        vscode.postMessage({ type: "restore", seq: msg.seq });
      });
      bubble.appendChild(restore);
    } else if (msg.role === "assistant") {
      if (msg.content && !msg.tool_calls?.length) {
        append(renderMarkdown(msg.content), "assistant");
      }
      for (const call of msg.tool_calls || []) {
        if (call.function?.name === "ask_question") {
          const qs = parseQuestions(call);
          if (qs.length) {
            renderQuestions(qs, laterUserAnswered(chat, chat.messages.indexOf(msg)));
          }
          continue;
        }
        const ok = call.status === "completed" ? true : call.status === "error" ? false : undefined;
        messagesEl.appendChild(toolRow("", call.function?.name || "tool", call.function?.arguments || "", call.result || "", ok));
      }
      if (msg.usage) {
        lastUsage = msg.usage;
      }
    }
  }
  if (lastUsage && lastUsage.percent != null) {
    setRing(lastUsage.percent);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function applyState(state) {
  const previousUser = lastAuth?.username;
  if (state.noWorkspace) {
    showGates(state.auth, true);
    showBanner("Open a folder before using CodeCook.", true);
    messagesEl.innerHTML = '<div class="empty">Open a folder to start.</div>';
    return;
  }
  if (!state.auth?.signedIn) {
    modelFormRequested = false;
  }
  showGates(state.auth, false);
  if (state.auth?.signedIn && state.auth.username !== previousUser) {
    modelChecked = new Set();
    modelPickTouched = false;
  }
  if (!probeState.running && Array.isArray(state.auth?.listed)) {
    listedModels = state.auth.listed;
    failedIds = new Set(state.auth.failed || []);
    if (!modelPickTouched) {
      modelChecked = new Set(listedModels.filter((model) => !failedIds.has(model.id)).map((model) => model.id));
    }
    renderModelScreen();
  }
  showBanner("", false);
  chatList.innerHTML = "";
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = "New chat";
  chatList.appendChild(empty);
  for (const c of state.chats || []) {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.title || "Untitled";
    chatList.appendChild(opt);
  }
  modelOptions = [{ id: "auto", label: "Auto" }, ...(state.models || [])];
  const chat = state.activeChat;
  chatList.value = chat?.id || "";
  setMode(chat?.mode || "agent");
  selectedModel = chat?.model || state.defaultModel || "auto";
  if (!modelOptions.some((item) => item.id === selectedModel)) {
    selectedModel = "auto";
  }
  syncEffortToModel();
  const nextId = chat?.id || "";
  renderModelButton();
  if (seenChatId !== null && seenChatId !== nextId) {
    pendingMentions = [];
    hideMentionMenu();
    renderChips();
  }
  seenChatId = nextId;
  if (!running) {
    renderHistory(chat);
  }
}

window.addEventListener("message", (event) => {
  const msg = event.data;
  switch (msg.type) {
    case "state":
      applyState(msg);
      if (msg.auth?.signedIn) {
        setSignInBusy(false);
      }
      break;
    case "show_key_form":
      showProviderKey(msg.provider || "openai");
      break;
    case "turn_started":
      setRunning(true);
      setActivity("Thinking");
      if (messagesEl.querySelector(".empty")) {
        messagesEl.innerHTML = "";
      }
      streamEl = null;
      ensureStream();
      break;
    case "turn_ended":
      setRunning(false);
      streamEl = null;
      break;
    case "thought_delta": {
      if (selectedThinking === "off") {
        break;
      }
      setActivity("Thinking");
      const el = ensureStream();
      const details = el.querySelector(".thought");
      const body = el.querySelector(".thought-body");
      el.dataset.thought = (el.dataset.thought || "") + msg.text;
      if (details && body) {
        details.classList.remove("hidden");
        body.textContent = el.dataset.thought;
      }
      messagesEl.scrollTop = messagesEl.scrollHeight;
      break;
    }
    case "content_delta": {
      setActivity("Writing");
      const el = ensureStream();
      el.dataset.raw = (el.dataset.raw || "") + msg.text;
      const answer = el.querySelector(".answer");
      if (answer) {
        answer.innerHTML = renderMarkdown(el.dataset.raw);
      } else {
        el.innerHTML = renderMarkdown(el.dataset.raw);
      }
      messagesEl.scrollTop = messagesEl.scrollHeight;
      break;
    }
    case "tool_call_start": {
      setActivity(toolPhase(msg.name));
      streamEl = null;
      if (msg.name === "ask_question") {
        break;
      }
      messagesEl.appendChild(toolRow(msg.call_id, msg.name, msg.arguments, "", undefined));
      break;
    }
    case "questions":
      setActivity("");
      renderQuestions(msg.questions || [], false);
      break;
    case "tool_call_result": {
      const card = document.getElementById(`call-${msg.call_id}`);
      if (card) {
        card.classList.add(msg.ok ? "ok" : "err");
        if (!msg.ok) {
          card.open = true;
        }
        const pre = card.querySelector("pre");
        if (pre) {
          pre.textContent = String(msg.result || "").slice(0, 2000);
        }
      }
      setActivity("Thinking");
      break;
    }
    case "todos_updated":
      append("Plan opened in the editor.", "status");
      break;
    case "usage":
      break;
    case "context":
      setRing(msg.percent);
      break;
    case "changes":
      changeFiles = Array.isArray(msg.files) ? msg.files : [];
      renderSideSections();
      break;
    case "tokens":
      tokenSnap = msg.tokens || null;
      if (tokenSnap?.contextPercent != null) setRing(tokenSnap.contextPercent);
      renderSideSections();
      break;
    case "open_tokens":
      tokenOpen = true;
      changesOpen = false;
      document.getElementById("account-menu")?.classList.add("hidden");
      renderSideSections();
      break;
    case "open_changes":
      changesOpen = true;
      tokenOpen = false;
      document.getElementById("account-menu")?.classList.add("hidden");
      renderSideSections();
      break;
    case "status":
    case "model_selected": {
      const text = msg.message || `Model: ${msg.model}`;
      if (isEphemeralStatus(text)) {
        setActivity(text.replace(/…/g, "").replace(/\.\.\.$/, ""));
        break;
      }
      append(escapeHtml(text), "status");
      break;
    }
    case "summarizing":
      setRunning(true);
      setActivity("Summarizing");
      break;
    case "key_saved":
      keyFormRequested = false;
      modelFormRequested = true;
      modelPickTouched = false;
      modelChecked = new Set();
      listedModels = [];
      failedIds = new Set();
      probeState = { running: false, done: 0, total: 0, failed: 0, error: "" };
      renderModelScreen();
      break;
    case "models_saved":
      modelFormRequested = false;
      showGates(lastAuth, false);
      break;
    case "model_list":
      listedModels = Array.isArray(msg.models) ? msg.models : [];
      failedIds = new Set(msg.failed || []);
      modelPickTouched = false;
      modelChecked = new Set(listedModels.filter((model) => !failedIds.has(model.id)).map((model) => model.id));
      probeState = { running: false, done: 0, total: 0, failed: failedIds.size, error: msg.error || "" };
      renderModelScreen();
      break;
    case "model_probe":
      probeState = {
        running: Boolean(msg.running),
        done: msg.done || 0,
        total: msg.total || 0,
        failed: msg.failed || 0,
        error: msg.error || "",
      };
      for (const model of msg.models || []) {
        failedIds.delete(model.id);
      }
      if (Array.isArray(msg.failedIds)) {
        if (msg.running) {
          for (const id of msg.failedIds) failedIds.add(id);
        } else {
          failedIds = new Set(msg.failedIds);
        }
      }
      renderModelScreen();
      break;
    case "models":
      modelOptions = [{ id: "auto", label: "Auto" }, ...(msg.models || [])];
      if (!modelOptions.some((item) => item.id === selectedModel)) {
        selectedModel = "auto";
      }
      syncEffortToModel();
      renderModelButton();
      break;
    case "auth_error": {
      const loginErr = document.getElementById("login-error");
      const keyErr = document.getElementById("key-error");
      const modelErr = document.getElementById("model-error");
      if (loginErr) loginErr.textContent = msg.error || "";
      if (keyErr) keyErr.textContent = msg.error || "";
      if (modelErr) modelErr.textContent = msg.error || "";
      setSignInBusy(false);
      break;
    }
    case "error":
      append(escapeHtml(msg.error || "Error"), "error");
      setRunning(false);
      break;
    case "done":
      streamEl = null;
      break;
    case "mention":
      addMentionChip(msg.mention);
      break;
    case "mentionResults":
      if (msg.query === mentionQuery && currentMention()) {
        mentionFiles = msg.files || [];
        mentionIndex = 0;
        renderMentionMenu();
      }
      break;
    case "dropAttach":
      addPending(msg.name, msg.mime, msg.data, String(msg.mime || "").startsWith("image/") ? `data:${msg.mime};base64,${msg.data}` : "");
      break;
  }
});

function modelSupportsThinking(id) {
  return String(id || "").includes("gemini-3");
}

function modelSupportsReasoning(id) {
  const name = String(id || "").toLowerCase();
  if (/^o\d/.test(name)) {
    return true;
  }
  const major = /^gpt-(\d+)/.exec(name);
  return Boolean(major && Number(major[1]) >= 5);
}

function modelShowsEffort(id) {
  return id !== "auto" && (modelSupportsThinking(id) || modelSupportsReasoning(id));
}

function syncEffortToModel() {
  if (!modelShowsEffort(selectedModel)) {
    selectedThinking = "off";
  }
}

function effortChoice() {
  return selectedModel === "auto" ? "low" : selectedThinking;
}

function thinkingSuffix(level) {
  if (!modelShowsEffort(selectedModel) || level === "off") {
    return "Off";
  }
  if (level === "LOW") return "Low";
  if (level === "MEDIUM") return "Med";
  if (level === "HIGH") return "High";
  return "Off";
}

function renderModelButton() {
  if (!modelBtn) return;
  const model = modelOptions.find((item) => item.id === selectedModel);
  const name = model?.label || "Auto";
  modelBtn.textContent = `${name} · ${thinkingSuffix(selectedThinking)}`;
}

function menuRow(label, selected, disabled, onClick) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = `menu-row${selected ? " selected" : ""}`;
  row.disabled = disabled;
  row.textContent = label;
  row.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return row;
}

const MODES = [
  { id: "chat", label: "Chat" },
  { id: "agent", label: "Agent" },
  { id: "plan", label: "Plan" },
];

function setMode(id) {
  selectedMode = MODES.some((mode) => mode.id === id) ? id : "agent";
  renderModeButton();
  if (modeMenu && !modeMenu.classList.contains("hidden")) {
    renderModeMenu();
  }
}

function renderModeButton() {
  if (!modeBtn) return;
  const mode = MODES.find((item) => item.id === selectedMode);
  modeBtn.textContent = mode?.label || "Agent";
}

function closeModeMenu() {
  modeMenu?.classList.add("hidden");
  modeBtn?.setAttribute("aria-expanded", "false");
}

function renderModeMenu() {
  if (!modeMenu) return;
  modeMenu.innerHTML = "";
  for (const mode of MODES) {
    modeMenu.appendChild(menuRow(mode.label, mode.id === selectedMode, false, () => {
      selectedMode = mode.id;
      renderModeButton();
      closeModeMenu();
    }));
  }
}

function renderModelMenu() {
  if (!modelMenu) return;
  modelMenu.innerHTML = "";
  for (const model of modelOptions) {
    modelMenu.appendChild(menuRow(model.label, model.id === selectedModel, false, () => {
      selectedModel = model.id;
      syncEffortToModel();
      renderModelButton();
      renderModelMenu();
    }));
  }
  if (!modelShowsEffort(selectedModel)) {
    return;
  }
  const label = document.createElement("div");
  label.className = "menu-label";
  label.textContent = modelSupportsReasoning(selectedModel) ? "Reasoning" : "Thinking";
  modelMenu.appendChild(label);
  for (const [id, text] of [["off", "Off"], ["LOW", "Low"], ["MEDIUM", "Medium"], ["HIGH", "High"]]) {
    modelMenu.appendChild(menuRow(text, selectedThinking === id, false, () => {
      selectedThinking = id;
      renderModelButton();
      renderModelMenu();
    }));
  }
}

function commandPreview(args) {
  try {
    const parsed = JSON.parse(args || "{}");
    const cmd = String(parsed.command || "").replace(/\s+/g, " ").trim();
    if (!cmd) {
      return "run_command";
    }
    return cmd.length > 80 ? `${cmd.slice(0, 80)}…` : cmd;
  } catch {
    return "run_command";
  }
}

function toolSummary(name, args) {
  let parsed = {};
  try {
    parsed = JSON.parse(args || "{}");
  } catch {
    parsed = {};
  }
  const path = typeof parsed.path === "string" ? parsed.path : "";
  const pattern = typeof parsed.pattern === "string" ? parsed.pattern : "";
  const short = (value) => (value.length > 72 ? `${value.slice(0, 72)}…` : value);
  if (name === "run_command") {
    return commandPreview(args);
  }
  if (name === "read_file" || name === "read_attachment") {
    return path ? `Read ${short(path)}` : "Read";
  }
  if (name === "list_dir") {
    return path ? `List ${short(path)}` : "List";
  }
  if (name === "grep") {
    return pattern ? `Search ${short(pattern)}` : "Search";
  }
  if (name === "glob") {
    return pattern ? `Find ${short(pattern)}` : "Find";
  }
  if (name === "write_file") {
    return path ? `Write ${short(path)}` : "Write";
  }
  if (name === "edit_file") {
    return path ? `Edit ${short(path)}` : "Edit";
  }
  if (name === "todo_write") {
    return "Update plan";
  }
  return name || "tool";
}

function toolRow(callId, name, args, result, ok) {
  const details = document.createElement("details");
  details.className = `tool cmd${ok === true ? " ok" : ok === false ? " err" : ""}`;
  if (callId) {
    details.id = `call-${callId}`;
  }
  if (ok === false) {
    details.open = true;
  }
  const summary = document.createElement("summary");
  summary.textContent = toolSummary(name, args);
  const pre = document.createElement("pre");
  const body = result ? String(result) : name === "run_command" ? "" : String(args || "");
  pre.textContent = body.slice(0, 2000);
  details.append(summary, pre);
  return details;
}

function visibleUserText(content) {
  return String(content || "")
    .replace(/--- Context file:[\s\S]*?--- End context file ---\n*/g, "")
    .replace(/\n*--- Mentioned file:[\s\S]*?--- End context file ---\n*/g, "")
    .replace(/\n*--- Terminal selection ---[\s\S]*?--- End terminal selection ---\n*/g, "")
    .replace(/\n*Attached documents\. Call read_attachment[\s\S]*?(?=\n*Attached images:|\n*Image description|$)/g, "")
    .replace(/\n*Attached images:[\s\S]*?(?=\n*Image description|$)/g, "")
    .trim();
}

function renderChips() {
  if (!attachChips) {
    return;
  }
  attachChips.innerHTML = "";
  for (const item of pending) {
    const chip = document.createElement("span");
    chip.className = "chip";
    if (item.preview) {
      const img = document.createElement("img");
      img.alt = "";
      img.src = item.preview;
      chip.appendChild(img);
    }
    const label = document.createElement("span");
    label.textContent = item.name;
    chip.appendChild(label);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.title = "Remove";
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      pending = pending.filter((entry) => entry.id !== item.id);
      renderChips();
    });
    chip.appendChild(remove);
    attachChips.appendChild(chip);
  }
  for (const item of pendingMentions) {
    const chip = document.createElement("span");
    chip.className = "chip";
    const label = document.createElement("span");
    label.textContent = item.label;
    chip.appendChild(label);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.title = "Remove";
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      pendingMentions = pendingMentions.filter((entry) => entry.id !== item.id);
      renderChips();
    });
    chip.appendChild(remove);
    attachChips.appendChild(chip);
  }
}

function addPending(name, mime, data, preview) {
  pending.push({ id: `a${chipSeq++}`, name, mime, data, preview: preview || "" });
  renderChips();
}

function readIntoPending(file, name, mime) {
  const label = name || file.name || "attachment";
  const type = mime || file.type || "";
  const image = IMAGE_MIME.includes(type);
  if (!image && !ATTACHMENT_EXT.test(label)) {
    append(`${escapeHtml(label)} is not a supported attachment.`, "error");
    return;
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    append(`${escapeHtml(label)} is larger than 8 MB.`, "error");
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = String(reader.result || "");
    const comma = dataUrl.indexOf(",");
    const data = comma >= 0 ? dataUrl.slice(comma + 1) : "";
    if (Math.floor(data.length * 0.75) > MAX_ATTACHMENT_BYTES) {
      append(`${escapeHtml(label)} is larger than 8 MB.`, "error");
      return;
    }
    addPending(label, type || "application/octet-stream", data, dataUrl.startsWith("data:image/") ? dataUrl : "");
  };
  reader.readAsDataURL(file);
}

function hideMentionMenu() {
  mentionFiles = [];
  mentionIndex = 0;
  mentionMenu?.classList.add("hidden");
}

function currentMention() {
  const cursor = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, cursor);
  const match = before.match(/(^|\s)@([^\s@]*)$/);
  if (!match) {
    return null;
  }
  return { query: match[2], start: cursor - match[2].length - 1 };
}

function renderMentionMenu() {
  if (!mentionMenu) {
    return;
  }
  mentionMenu.innerHTML = "";
  if (!mentionFiles.length) {
    mentionMenu.classList.add("hidden");
    return;
  }
  mentionFiles.forEach((file, index) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `menu-row${index === mentionIndex ? " selected" : ""}`;
    row.textContent = file;
    row.addEventListener("mousedown", (event) => {
      event.preventDefault();
      chooseMention(file);
    });
    mentionMenu.appendChild(row);
  });
  mentionMenu.classList.remove("hidden");
}

function chooseMention(rel) {
  const cursor = input.selectionStart ?? input.value.length;
  const start = mentionStart >= 0 ? mentionStart : cursor;
  input.value = `${input.value.slice(0, start)}${input.value.slice(cursor)}`;
  const next = Math.max(0, start);
  input.selectionStart = next;
  input.selectionEnd = next;
  hideMentionMenu();
  addMentionChip({ kind: "file", label: rel, path: rel });
  input.focus();
}

function addMentionChip(mention) {
  if (!mention || !mention.label) {
    return;
  }
  const ack = () => {
    if (mention.id) {
      vscode.postMessage({ type: "mentionAck", id: mention.id });
    }
  };
  if (mention.id && pendingMentions.some((item) => item.id === mention.id)) {
    ack();
    return;
  }
  if (mention.kind === "file" && pendingMentions.some((item) => item.kind === "file" && item.path === mention.path)) {
    ack();
    return;
  }
  if (pendingMentions.length >= MAX_MENTIONS) {
    append("You can mention up to 8 items.", "error");
    ack();
    return;
  }
  pendingMentions.push({
    id: mention.id || `m${chipSeq++}`,
    kind: mention.kind,
    label: mention.label,
    path: mention.path,
    text: mention.text,
  });
  renderChips();
  ack();
}

function send() {
  const content = input.value;
  if ((!content.trim() && !pending.length && !pendingMentions.length) || running) {
    return;
  }
  if (messagesEl.querySelector(".empty")) {
    messagesEl.innerHTML = "";
  }
  const chips = [...pendingMentions.map((item) => item.label), ...pending.map((item) => item.name)]
    .map((name) => `<span class="chip">${escapeHtml(name)}</span>`)
    .join("");
  append(`${chips}<p>${escapeHtml(content.trim())}</p>`, "user");
  vscode.postMessage({
    type: "send",
    content,
    mode: selectedMode,
    model: selectedModel,
    thinking: effortChoice(),
    attachments: pending.map((item) => ({ name: item.name, mime: item.mime, data: item.data })),
    mentions: pendingMentions.map((item) => ({
      kind: item.kind,
      label: item.label,
      path: item.path,
      text: item.text,
    })),
  });
  input.value = "";
  pending = [];
  pendingMentions = [];
  hideMentionMenu();
  renderChips();
}

let keyFormRequested = false;
let modelFormRequested = false;
let lastAuth = null;
let listedModels = [];
let failedIds = new Set();
let modelChecked = new Set();
let modelPickTouched = false;
let probeState = { running: false, done: 0, total: 0, failed: 0, error: "" };
let changesOpen = false;
let tokenOpen = false;
let changeFiles = [];
let tokenSnap = null;

function setTokenText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value || "";
}

function renderSideSections() {
  if (!lastAuth?.signedIn) {
    changesOpen = false;
    tokenOpen = false;
  }
  document.getElementById("changes-menu")?.classList.toggle("hidden", !changesOpen);
  document.getElementById("token-menu")?.classList.toggle("hidden", !tokenOpen);
  document.getElementById("changes-toggle")?.setAttribute("aria-expanded", changesOpen ? "true" : "false");
  document.getElementById("token-toggle")?.setAttribute("aria-expanded", tokenOpen ? "true" : "false");
  const countEl = document.getElementById("changes-count");
  if (countEl) countEl.textContent = String(changeFiles.length);
  const list = document.getElementById("changes-list");
  if (list) {
    list.replaceChildren();
    for (const file of changeFiles) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "change-row";
      button.textContent = file.created ? `${file.rel} · added` : file.rel;
      button.title = file.rel || "";
      button.addEventListener("click", () => vscode.postMessage({ type: "openDiff", fsPath: file.fsPath }));
      list.appendChild(button);
    }
  }
  document.getElementById("changes-empty")?.classList.toggle("hidden", changeFiles.length > 0);
  document.getElementById("changes-actions")?.classList.toggle("hidden", changeFiles.length === 0);
  const summary = document.getElementById("token-summary");
  if (summary) summary.textContent = `${Math.round(tokenSnap?.savedPercent || 0)}%`;
  const activity = document.getElementById("token-activity");
  const activityLabel = document.getElementById("token-activity-label");
  activity?.classList.toggle("hidden", !tokenSnap?.activity);
  if (activityLabel) activityLabel.textContent = tokenSnap?.activity || "";
  setTokenText("token-saved-pct", `${Math.round(tokenSnap?.savedPercent || 0)}%`);
  setTokenText("token-model", tokenSnap?.model || "—");
  setTokenText("token-saved-legend", tokenSnap?.savedLegend || "0");
  setTokenText("token-cache-legend", tokenSnap?.cacheLegend || "—");
  setTokenText("token-without", tokenSnap?.withoutTokens || "0 tokens");
  setTokenText("token-with", tokenSnap?.withTokens || "0 tokens");
  setTokenBar("token-without-bar", tokenSnap?.withoutPct || 0);
  setTokenBar("token-with-bar", tokenSnap?.withPct || 0);
  setTokenArc("token-arc-saved", tokenSnap?.savedPercent || 0);
  setTokenArc("token-arc-cache", tokenSnap?.cacheVisible ? tokenSnap.cachePercent || 0 : 0);
  setTokenText("token-cost", tokenSnap?.costTurn || "$0.00");
  setTokenText("token-session-tokens", tokenSnap?.sessionTokens || "0");
  setTokenText("token-session-usd", tokenSnap?.sessionUsd || "~$0.00");
  setTokenText("token-context", tokenSnap?.contextLabel || "0 / 1M");
  setTokenBar("token-context-bar", tokenSnap?.contextPct || 0);
  setTokenText("token-month", tokenSnap?.month || "$0.00 · No cap");
  setTokenBar("token-month-bar", tokenSnap?.monthPct || 0);
  const monthRow = document.getElementById("token-month-row");
  if (monthRow) monthRow.className = `token-meter-block${tokenSnap?.monthClass ? ` ${tokenSnap.monthClass}` : ""}`;
  setTokenText("token-projected", `Projected this month: ${tokenSnap?.projected || "about $0.00"}`);
  setTokenText("token-saved-turn", tokenSnap?.savedTurn || "~$0.00");
  setTokenText("token-user", tokenSnap?.user || "0");
  setTokenText("token-prompt", tokenSnap?.prompt || "0");
  setTokenText("token-output", tokenSnap?.output || "0");
  setTokenText("token-cached", tokenSnap?.cached || "—");
  setTokenText("token-uncached", tokenSnap?.withoutCache || "");
  document.getElementById("token-uncached-row")?.classList.toggle("hidden", !tokenSnap?.withoutCache);
  setTokenText("token-session-cache", tokenSnap?.sessionCache || "~$0.00");
  setTokenText("token-summaries", tokenSnap?.summaries || "0");
  const limit = document.getElementById("token-limit");
  if (limit && document.activeElement !== limit) limit.value = tokenSnap?.limit ? String(tokenSnap.limit) : "";
  const summarize = document.getElementById("btn-summarize");
  if (summarize) summarize.disabled = Boolean(tokenSnap?.activity);
}

function setTokenBar(id, pct) {
  const el = document.getElementById(id);
  if (!el) return;
  const value = Math.max(0, Math.min(100, Number(pct) || 0));
  el.style.width = `${value}%`;
}

function setTokenArc(id, pct) {
  const el = document.getElementById(id);
  if (!el) return;
  const radius = Number(el.getAttribute("r")) || 0;
  const circ = 2 * Math.PI * radius;
  const value = Math.max(0, Math.min(100, Number(pct) || 0));
  const drawn = (value / 100) * circ;
  el.style.strokeDasharray = `${drawn} ${circ}`;
  el.style.opacity = value > 0 ? "1" : "0";
}

function showGates(auth, noWorkspace) {
  if (auth) lastAuth = auth;
  const login = document.getElementById("login-gate");
  const key = document.getElementById("key-gate");
  const modelGate = document.getElementById("model-gate");
  const accountBtn = document.getElementById("btn-account");
  const showLogin = !noWorkspace && !auth?.signedIn;
  const showKey = !noWorkspace && Boolean(auth?.signedIn) && (Boolean(auth?.needsKey) || keyFormRequested);
  const showModel = !showLogin && !showKey && Boolean(auth?.signedIn) && (Boolean(auth?.needsModelPick) || modelFormRequested);
  login?.classList.toggle("hidden", !showLogin);
  document.querySelector(".bar")?.classList.toggle("hidden", !auth?.signedIn);
  key?.classList.toggle("hidden", !showKey);
  modelGate?.classList.toggle("hidden", !showModel);
  messagesEl?.classList.toggle("hidden", showLogin || showKey || showModel);
  composer?.classList.toggle("hidden", showLogin || showKey || showModel);
  accountBtn?.classList.toggle("hidden", !auth?.signedIn);
  const username = auth?.username || "Account";
  if (accountBtn) {
    accountBtn.title = username;
    accountBtn.setAttribute("aria-label", username);
  }
  const accountName = document.getElementById("account-name");
  const accountRole = document.getElementById("account-role");
  const accountAvatar = document.getElementById("account-avatar");
  if (accountName) accountName.textContent = username;
  if (accountRole) accountRole.textContent = "Local";
  if (accountAvatar) accountAvatar.textContent = username.slice(0, 1).toUpperCase();
  if (!auth?.signedIn) {
    changesOpen = false;
    tokenOpen = false;
  }
  renderSideSections();
  document.getElementById("btn-key-cancel")?.classList.toggle("hidden", !showKey || Boolean(auth?.needsKey));
  const more = document.getElementById("more-box");
  if (more) {
    more.innerHTML = "";
    for (const choice of auth?.ambient || []) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "gate-secondary";
      button.textContent = choice.label;
      button.addEventListener("click", () => vscode.postMessage({ type: "useAmbient", ambient: choice.id }));
      more.appendChild(button);
    }
  }
  if (!showLogin) {
    const loginErr = document.getElementById("login-error");
    if (loginErr) loginErr.textContent = "";
  }
  if (!showKey) {
    const keyErr = document.getElementById("key-error");
    if (keyErr) keyErr.textContent = "";
  }
}

function renderModelScreen() {
  const progress = document.getElementById("model-progress");
  const box = document.getElementById("model-checks");
  const error = document.getElementById("model-error");
  const stop = document.getElementById("btn-model-stop");
  const test = document.getElementById("btn-model-test");
  const cont = document.getElementById("btn-model-continue");
  if (progress) {
    if (probeState.running) {
      progress.textContent = probeState.total ? `Testing ${probeState.done} of ${probeState.total}` : "Testing models…";
    } else if (!listedModels.length) {
      progress.textContent = probeState.error ? "Could not list models." : "Loading models…";
    } else {
      progress.textContent = "Choose the models to show in chat.";
    }
  }
  if (error) error.textContent = probeState.error || "";
  stop?.classList.toggle("hidden", !probeState.running);
  test?.classList.toggle("hidden", probeState.running || listedModels.length > 0);
  document.getElementById("model-bulk")?.classList.toggle("hidden", !listedModels.length);
  if (box) {
    box.innerHTML = "";
    const sorted = [...listedModels].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    for (const model of sorted) {
      const label = document.createElement("label");
      label.className = "model-check";
      const failed = failedIds.has(model.id);
      if (failed) label.classList.add("failed");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = model.id;
      input.checked = modelChecked.has(model.id);
      input.addEventListener("change", () => {
        modelPickTouched = true;
        if (input.checked) modelChecked.add(model.id);
        else modelChecked.delete(model.id);
        updateModelContinue();
      });
      const name = document.createElement("span");
      const title = model.label || model.id;
      name.textContent = failed ? `${title} · did not reply` : title;
      name.title = name.textContent;
      label.append(input, name);
      box.appendChild(label);
    }
  }
  updateModelContinue();
}

function updateModelContinue() {
  const cont = document.getElementById("btn-model-continue");
  if (cont) cont.disabled = probeState.running || !listedModels.some((model) => modelChecked.has(model.id));
}

function gateValue(id) {
  return document.getElementById(id)?.value || "";
}

btnSend.addEventListener("click", send);
document.getElementById("btn-enter")?.addEventListener("click", () => {
  setSignInBusy(true);
  const loginErr = document.getElementById("login-error");
  if (loginErr) loginErr.textContent = "";
  vscode.postMessage({ type: "enterApp" });
});
document.getElementById("btn-account")?.addEventListener("click", (event) => {
  event.stopPropagation();
  const menu = document.getElementById("account-menu");
  const open = menu?.classList.contains("hidden");
  changesOpen = false;
  tokenOpen = false;
  closeModeMenu();
  modelMenu?.classList.add("hidden");
  renderSideSections();
  menu?.classList.toggle("hidden", !open);
});
document.getElementById("account-menu")?.addEventListener("click", (event) => event.stopPropagation());
document.getElementById("btn-use-key")?.addEventListener("click", () => {
  keyFormRequested = true;
  modelFormRequested = false;
  document.getElementById("account-menu")?.classList.add("hidden");
  showGates(lastAuth, false);
});
document.getElementById("btn-choose-models")?.addEventListener("click", () => {
  keyFormRequested = false;
  modelFormRequested = true;
  modelPickTouched = false;
  listedModels = lastAuth?.listed || [];
  failedIds = new Set(lastAuth?.failed || []);
  modelChecked = new Set((lastAuth?.models || []).map((item) => item.id));
  probeState = { running: false, done: 0, total: 0, failed: failedIds.size, error: "" };
  document.getElementById("account-menu")?.classList.add("hidden");
  showGates(lastAuth, false);
  renderModelScreen();
  vscode.postMessage({ type: "chooseModels" });
});
document.getElementById("btn-key-cancel")?.addEventListener("click", () => {
  keyFormRequested = false;
  showGates(lastAuth, false);
});
document.getElementById("btn-model-stop")?.addEventListener("click", () => {
  vscode.postMessage({ type: "stopProbe" });
});
document.getElementById("btn-model-test")?.addEventListener("click", () => {
  probeState = { ...probeState, running: true, error: "" };
  renderModelScreen();
  vscode.postMessage({ type: "startProbe" });
});
document.getElementById("btn-model-all")?.addEventListener("click", () => {
  modelPickTouched = true;
  modelChecked = new Set(listedModels.map((model) => model.id));
  renderModelScreen();
});
document.getElementById("btn-model-none")?.addEventListener("click", () => {
  modelPickTouched = true;
  modelChecked = new Set();
  renderModelScreen();
});
document.getElementById("btn-model-continue")?.addEventListener("click", () => {
  const ids = listedModels.filter((model) => modelChecked.has(model.id)).map((model) => model.id);
  vscode.postMessage({ type: "saveModels", ids });
});
document.getElementById("btn-model-back")?.addEventListener("click", () => {
  modelFormRequested = false;
  if (lastAuth?.needsModelPick) {
    keyFormRequested = true;
  }
  showGates(lastAuth, false);
});
document.getElementById("btn-signout")?.addEventListener("click", () => {
  keyFormRequested = false;
  modelFormRequested = false;
  document.getElementById("account-menu")?.classList.add("hidden");
  vscode.postMessage({ type: "signOut" });
});
document.getElementById("btn-key-signout")?.addEventListener("click", () => {
  keyFormRequested = false;
  modelFormRequested = false;
  vscode.postMessage({ type: "signOut" });
});
function setSignInBusy(busy) {
  const button = document.getElementById("btn-enter");
  if (button) button.disabled = busy;
}

function showProviderKey(provider) {
  keyFormRequested = true;
  modelFormRequested = false;
  document.getElementById("account-menu")?.classList.add("hidden");
  document.getElementById("api-key-form")?.classList.remove("hidden");
  document.getElementById("cloud-form")?.classList.add("hidden");
  document.getElementById("more-box")?.classList.add("hidden");
  const select = document.getElementById("key-provider");
  if (select) {
    select.value = provider;
    select.dispatchEvent(new Event("change"));
  }
  document.getElementById("key-hint")?.classList.remove("hidden");
  showGates(lastAuth, false);
}

document.getElementById("btn-connect-chatgpt")?.addEventListener("click", () => {
  vscode.postMessage({ type: "connectChatGpt" });
});
document.getElementById("btn-connect-claude")?.addEventListener("click", () => {
  vscode.postMessage({ type: "connectClaude" });
});
document.getElementById("btn-connect-chatgpt-menu")?.addEventListener("click", () => {
  document.getElementById("account-menu")?.classList.add("hidden");
  vscode.postMessage({ type: "connectChatGpt" });
});
document.getElementById("btn-connect-claude-menu")?.addEventListener("click", () => {
  document.getElementById("account-menu")?.classList.add("hidden");
  vscode.postMessage({ type: "connectClaude" });
});
document.getElementById("btn-show-key")?.addEventListener("click", () => {
  document.getElementById("api-key-form")?.classList.remove("hidden");
  document.getElementById("cloud-form")?.classList.add("hidden");
  document.getElementById("more-box")?.classList.add("hidden");
  document.getElementById("key-hint")?.classList.add("hidden");
});
document.getElementById("btn-show-cloud")?.addEventListener("click", () => {
  document.getElementById("cloud-form")?.classList.remove("hidden");
  document.getElementById("api-key-form")?.classList.add("hidden");
  document.getElementById("more-box")?.classList.add("hidden");
  vscode.postMessage({ type: "startCloudLogin" });
});
document.getElementById("btn-show-more")?.addEventListener("click", () => {
  document.getElementById("more-box")?.classList.remove("hidden");
  document.getElementById("api-key-form")?.classList.add("hidden");
  document.getElementById("cloud-form")?.classList.add("hidden");
});
document.getElementById("key-provider")?.addEventListener("change", (event) => {
  const provider = event.target.value;
  document.getElementById("key-azure")?.classList.toggle("hidden", provider !== "azure");
  document.getElementById("key-aws-secret")?.classList.toggle("hidden", provider !== "aws");
  document.getElementById("key-aws-region")?.classList.toggle("hidden", provider !== "aws");
  const key = document.getElementById("key-value");
  if (key) key.placeholder = provider === "aws" ? "AWS access key" : "API key";
});
document.getElementById("api-key-form")?.addEventListener("submit", (event) => {
  event.preventDefault();
  vscode.postMessage({
    type: "saveKey",
    provider: gateValue("key-provider"),
    apiKey: gateValue("key-value"),
    azureEndpoint: gateValue("key-azure"),
    awsSecret: gateValue("key-aws-secret"),
    awsRegion: gateValue("key-aws-region"),
    modelId: gateValue("key-model"),
    source: "api-key",
  });
});
document.getElementById("cloud-form")?.addEventListener("submit", (event) => {
  event.preventDefault();
  vscode.postMessage({
    type: "saveKey",
    provider: "google",
    source: "gcloud",
    gcpProject: gateValue("cloud-project"),
  });
});
btnCancel.addEventListener("click", () => vscode.postMessage({ type: "cancel" }));
btnNew.addEventListener("click", () => vscode.postMessage({ type: "newChat" }));
function openTokenPopup() {
  tokenOpen = !tokenOpen;
  if (tokenOpen) changesOpen = false;
  document.getElementById("account-menu")?.classList.add("hidden");
  modelMenu?.classList.add("hidden");
  closeModeMenu();
  renderSideSections();
}
function openChangesPopup() {
  changesOpen = !changesOpen;
  if (changesOpen) tokenOpen = false;
  document.getElementById("account-menu")?.classList.add("hidden");
  modelMenu?.classList.add("hidden");
  closeModeMenu();
  renderSideSections();
}
ringBtn?.addEventListener("click", (event) => {
  event.stopPropagation();
  openTokenPopup();
});
document.getElementById("changes-toggle")?.addEventListener("click", (event) => {
  event.stopPropagation();
  openChangesPopup();
});
document.getElementById("token-toggle")?.addEventListener("click", (event) => {
  event.stopPropagation();
  openTokenPopup();
});
document.getElementById("changes-menu")?.addEventListener("click", (event) => event.stopPropagation());
document.getElementById("token-menu")?.addEventListener("click", (event) => event.stopPropagation());
document.getElementById("token-details-toggle")?.addEventListener("click", () => {
  const details = document.getElementById("token-details");
  const toggle = document.getElementById("token-details-toggle");
  const open = details?.classList.contains("hidden");
  details?.classList.toggle("hidden", !open);
  toggle?.setAttribute("aria-expanded", open ? "true" : "false");
  if (toggle) toggle.textContent = open ? "Hide details" : "Show details";
});
document.getElementById("btn-keep-all")?.addEventListener("click", () => vscode.postMessage({ type: "keepAll" }));
document.getElementById("btn-revert-all")?.addEventListener("click", () => vscode.postMessage({ type: "revertAll" }));
document.getElementById("btn-summarize")?.addEventListener("click", () => vscode.postMessage({ type: "summarize" }));
document.getElementById("btn-savings")?.addEventListener("click", () => vscode.postMessage({ type: "savingsReport" }));
document.getElementById("token-limit")?.addEventListener("change", (event) => {
  vscode.postMessage({ type: "setLimits", monthly: Number(event.target.value) || 0 });
});
modelBtn?.addEventListener("click", (event) => {
  event.stopPropagation();
  closeModeMenu();
  renderModelMenu();
  modelMenu?.classList.toggle("hidden");
});
modeBtn?.addEventListener("click", (event) => {
  event.stopPropagation();
  const open = modeMenu?.classList.contains("hidden");
  modelMenu?.classList.add("hidden");
  document.getElementById("account-menu")?.classList.add("hidden");
  changesOpen = false;
  tokenOpen = false;
  renderSideSections();
  if (open) renderModeMenu();
  modeMenu?.classList.toggle("hidden", !open);
  modeBtn.setAttribute("aria-expanded", open ? "true" : "false");
});
modelMenu?.addEventListener("click", (event) => event.stopPropagation());
modeMenu?.addEventListener("click", (event) => event.stopPropagation());
mentionMenu?.addEventListener("mousedown", (event) => event.stopPropagation());
document.addEventListener("click", () => {
  modelMenu?.classList.add("hidden");
  closeModeMenu();
  changesOpen = false;
  tokenOpen = false;
  document.getElementById("account-menu")?.classList.add("hidden");
  renderSideSections();
  hideMentionMenu();
});
messagesEl?.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : event.target?.parentElement;
  const link = target?.closest?.("a[data-external]");
  if (!link) {
    return;
  }
  event.preventDefault();
  const url = link.getAttribute("href") || "";
  if (!/^https?:\/\//i.test(url)) {
    return;
  }
  vscode.postMessage({ type: "openLink", url });
});
renderModelButton();
renderModeButton();
chatList.addEventListener("change", () => {
  if (chatList.value) {
    vscode.postMessage({ type: "selectChat", id: chatList.value });
  } else {
    vscode.postMessage({ type: "newChat" });
  }
});
input.addEventListener("keydown", (e) => {
  const menuOpen = mentionMenu && !mentionMenu.classList.contains("hidden") && mentionFiles.length;
  if (menuOpen && e.key === "ArrowDown") {
    e.preventDefault();
    mentionIndex = (mentionIndex + 1) % mentionFiles.length;
    renderMentionMenu();
    return;
  }
  if (menuOpen && e.key === "ArrowUp") {
    e.preventDefault();
    mentionIndex = (mentionIndex - 1 + mentionFiles.length) % mentionFiles.length;
    renderMentionMenu();
    return;
  }
  if (e.key === "Escape") {
    hideMentionMenu();
    return;
  }
  if (e.key === "Enter" && !e.shiftKey) {
    if (menuOpen) {
      e.preventDefault();
      chooseMention(mentionFiles[mentionIndex]);
      return;
    }
    e.preventDefault();
    send();
  }
});
input.addEventListener("input", () => {
  const found = currentMention();
  if (!found) {
    hideMentionMenu();
    return;
  }
  mentionStart = found.start;
  mentionQuery = found.query;
  clearTimeout(mentionTimer);
  mentionTimer = setTimeout(() => {
    vscode.postMessage({ type: "mentionQuery", query: mentionQuery });
  }, 120);
});
function dragData(transfer, type) {
  try {
    return transfer?.getData(type) || "";
  } catch {
    return "";
  }
}

function looksLikeFileTarget(line) {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(line) || /[\\/]/.test(line) || /^[a-zA-Z]:/.test(line);
}

function collectDropLines(value, targets) {
  const add = (line) => {
    if (line && looksLikeFileTarget(line) && !targets.includes(line)) {
      targets.push(line);
    }
  };
  String(value || "")
    .split(/\r?\n/)
    .forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        return;
      }
      if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
        try {
          const parsed = JSON.parse(trimmed);
          const rows = Array.isArray(parsed) ? parsed : [parsed];
          rows.forEach((row) => {
            if (typeof row === "string") {
              add(row.trim());
            } else if (row && typeof row === "object") {
              add(String(row.resource || row.fsPath || row.path || row.external || "").trim());
            }
          });
          return;
        } catch {
          // Not JSON. Treat the line as a path.
        }
      }
      if (trimmed.includes("://") && /\s/.test(trimmed)) {
        trimmed.split(/\s+/).forEach(add);
        return;
      }
      add(trimmed);
    });
}

function dropTargets(transfer) {
  const targets = [];
  for (const type of ["text/uri-list", "application/vnd.code.uri-list", "CodeFiles", "ResourceURLs", "URL", "text/x-moz-url"]) {
    collectDropLines(dragData(transfer, type), targets);
  }
  if (!targets.length) {
    collectDropLines(dragData(transfer, "text/plain"), targets);
  }
  const loose = [];
  for (const file of Array.from(transfer?.files || [])) {
    const filePath = globalThis.vscode?.webUtils?.getPathForFile?.(file) || file.path || "";
    if (filePath) {
      collectDropLines(filePath, targets);
    } else {
      loose.push(file);
    }
  }
  return { targets, loose };
}

function readItemStrings(transfer) {
  const reads = [];
  for (const item of Array.from(transfer?.items || [])) {
    if (item.kind !== "string") {
      continue;
    }
    reads.push(new Promise((resolve) => {
      try {
        item.getAsString((value) => resolve(value || ""));
      } catch {
        resolve("");
      }
    }));
  }
  return Promise.all(reads);
}

function dragTypes(transfer) {
  return Array.from(transfer?.types || []);
}

function isFileDrag(transfer) {
  return dragTypes(transfer).some((type) =>
    type === "Files" ||
    type === "CodeFiles" ||
    type === "ResourceURLs" ||
    type === "text/uri-list" ||
    type === "application/vnd.code.uri-list" ||
    type === "DownloadURL" ||
    type === "URL"
  );
}

function overChat(event) {
  const app = document.getElementById("app");
  return !!(app && event.target instanceof Node && (event.target === app || app.contains(event.target)));
}

function chooseDropEffect(transfer) {
  const allowed = String(transfer?.effectAllowed || "all");
  if (allowed === "move" || allowed === "linkMove") {
    return "move";
  }
  if (allowed === "link" || allowed === "copyLink") {
    return "link";
  }
  return "copy";
}

function acceptComposerDrag(event) {
  if (!isFileDrag(event.dataTransfer) && !overChat(event)) {
    return;
  }
  event.preventDefault();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = chooseDropEffect(event.dataTransfer);
  }
  composer?.classList.add("dragover");
}

window.addEventListener("drop", (event) => {
  if (!isFileDrag(event.dataTransfer) && !overChat(event)) {
    return;
  }
  event.preventDefault();
  const types = dragTypes(event.dataTransfer);
  const found = dropTargets(event.dataTransfer);
  const stringReads = readItemStrings(event.dataTransfer);
  composer?.classList.remove("dragover");
  void finishDrop(found, stringReads, types);
});

async function finishDrop(found, stringReads, types) {
  if (!found.targets.length) {
    for (const value of await stringReads) {
      collectDropLines(value, found.targets);
    }
  }
  if (found.targets.length) {
    vscode.postMessage({ type: "dropUris", uris: found.targets });
  }
  for (const file of found.loose) {
    readIntoPending(file, file.name, file.type);
  }
  if (!found.targets.length && !found.loose.length) {
    const carried = types.length ? types.join(", ") : "no data";
    append(escapeHtml(`The drop reached CodeCook but had no file path (it carried: ${carried}).`), "error");
  }
}

window.addEventListener("dragenter", acceptComposerDrag);
window.addEventListener("dragover", acceptComposerDrag);
window.addEventListener("dragend", () => composer?.classList.remove("dragover"));
input.addEventListener("paste", (event) => {
  const items = event.clipboardData && event.clipboardData.items;
  if (!items) {
    return;
  }
  const images = [];
  for (const item of items) {
    if (item.kind === "file" && IMAGE_MIME.includes(item.type)) {
      const file = item.getAsFile();
      if (file) {
        images.push(file);
      }
    }
  }
  if (!images.length) {
    return;
  }
  event.preventDefault();
  const text = event.clipboardData.getData("text/plain");
  if (text) {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    input.value = `${input.value.slice(0, start)}${text}${input.value.slice(end)}`;
    input.selectionStart = input.selectionEnd = start + text.length;
  }
  images.forEach((file, index) => {
    const raw = file.name || "";
    const name = !raw || raw === "image.png" ? (index === 0 ? "screenshot.png" : `screenshot-${index + 1}.png`) : raw;
    readIntoPending(file, name, file.type || "image/png");
  });
});
btnAttach?.addEventListener("click", () => fileInput?.click());
fileInput?.addEventListener("change", () => {
  Array.from(fileInput.files || []).forEach((file) => readIntoPending(file, file.name, file.type));
  fileInput.value = "";
});

function buildCodeMatrix() {
  const root = document.getElementById("code-matrix");
  if (!root || root.childElementCount) {
    return;
  }
  const glyphs = [
    "const", "let", "=>", "fn()", "{}", "[]", "if (", "for", "await",
    "return", "async", "class", "import", "export", "try {", "catch",
    "&&", "||", "??", "?.", "===", "++", "null", "0x1f", "new",
    "this.", "map(", "grep", "edit", "path", "yield", "type", "while",
    "</>", "{ }", "();", "=> {", "break", "case", "void", "else",
  ];
  const lines = 40;
  for (let col = 0; col < 14; col += 1) {
    const column = document.createElement("div");
    column.className = `matrix-col d${col % 6}`;
    const tokens = [];
    for (let row = 0; row < lines; row += 1) {
      tokens.push(glyphs[(col * 5 + row * 3) % glyphs.length]);
    }
    const densities = [0.16, 0.28, 0.4, 0.52, 0.66, 0.8, 0.92, 1];
    tokens.concat(tokens).forEach((token, row) => {
      const cell = document.createElement("span");
      const level = densities[(col * 4 + (row % tokens.length) * 3) % densities.length];
      cell.textContent = token;
      cell.style.opacity = String(level);
      if (level > 0.85) {
        cell.style.textShadow = "0 0 8px rgba(56, 191, 160, 0.7)";
      }
      column.appendChild(cell);
    });
    root.appendChild(column);
  }
}

buildCodeMatrix();
vscode.postMessage({ type: "ready" });
