import * as vscode from "vscode";
import * as path from "path";
import { spawn } from "child_process";
import { documentText, readAttachmentFile } from "./attachments";
import { applyExactEdits, isThinHtml, PathJailError, resolveWorkspacePath, type FileEdit } from "./path";
import { middleTruncate, numberLines } from "./text";
import type { Mode, Settings, ToolResult, ToolSchema, Todo } from "./types";
import { getWorkspaceFolder } from "./store";
import type { ChangeTracker } from "./changes";
import { isThinPlanMd, parseAskQuestions } from "./planQuality";
import { applyProjectNote, PROJECT_DIR, PROJECT_FILE, PROJECT_SECTIONS, readProjectMarkdown, writeProjectMarkdown } from "./projectFile";

export { applyExactEdits, PathJailError, resolveWorkspacePath } from "./path";

function isProjectNotePath(rel: string): boolean {
  const normalized = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  return normalized === `${PROJECT_DIR}/${PROJECT_FILE}` || normalized.endsWith(`/${PROJECT_DIR}/${PROJECT_FILE}`);
}

function fail(text: string): ToolResult {
  return { text, ok: false };
}

function ok(text: string, extra?: Partial<ToolResult>): ToolResult {
  return { text, ok: true, ...extra };
}

async function readPreferEditor(uri: vscode.Uri): Promise<string> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
  if (open) {
    return open.getText();
  }
  const bytes = await vscode.workspace.fs.readFile(uri);
  return Buffer.from(bytes).toString("utf8");
}

async function writeViaEdit(uri: vscode.Uri, content: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const range = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
    edit.replace(uri, range, content);
  } catch {
    edit.createFile(uri, { overwrite: true, ignoreIfExists: true });
    edit.insert(uri, new vscode.Position(0, 0), content);
  }
  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    throw new Error("Workspace edit was not applied");
  }
}

async function ensureParents(uri: vscode.Uri): Promise<void> {
  const dir = vscode.Uri.file(path.dirname(uri.fsPath));
  await vscode.workspace.fs.createDirectory(dir);
}

export function toolSchemas(mode: Mode): ToolSchema[] {
  const readTools: ToolSchema[] = [
    schema("read_file", "Read a file and return its contents with line numbers. PDF and Word (.docx) files return extracted text. Old .doc files cannot be parsed. Use offset and limit for large files.", {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the file within the workspace." },
        offset: { type: "integer", description: "1-based starting line number. Defaults to line 1." },
        limit: { type: "integer", description: "Maximum number of lines to return." },
      },
      required: ["path"],
    }),
    schema(
      "read_attachment",
      "Read a file the user attached in this chat. path is the temporary path listed in the user message, not a workspace path. Returns extracted text for PDF, Word (.docx), HTML, and plain text. Old .doc files are not parsed.",
      {
        type: "object",
        properties: {
          path: { type: "string", description: "Temporary attachment path from the user message." },
          offset: { type: "integer", description: "1-based starting line number. Defaults to line 1." },
          limit: { type: "integer", description: "Maximum number of lines to return." },
        },
        required: ["path"],
      }
    ),
    schema("list_dir", "List the contents of a directory, showing file types and sizes.", {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the directory. Defaults to the workspace root." },
      },
    }),
    schema("grep", "Search for a pattern in files using ripgrep (preferred) or a workspace text search.", {
      type: "object",
      properties: {
        pattern: { type: "string", description: "The search pattern (regex)." },
        path: { type: "string", description: "Directory or file to search. Defaults to workspace root." },
        case_insensitive: { type: "boolean", description: "Case-insensitive search." },
        output_mode: {
          type: "string",
          enum: ["content", "files_with_matches", "count"],
          description: "Output format: matching lines (content), filenames only, or match counts.",
        },
        head_limit: { type: "integer", description: "Maximum number of output lines. Default 100, max 1000." },
      },
      required: ["pattern"],
    }),
    schema("glob", "Find files matching a glob pattern in the workspace.", {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern to match files (e.g., '*.py', '**/*.js')." },
        path: { type: "string", description: "Directory to search in. Defaults to workspace root." },
        head_limit: { type: "integer", description: "Maximum number of results. Default 200, max 1000." },
      },
      required: ["pattern"],
    }),
  ];

  if (mode === "chat") {
    return readTools;
  }

  const planTools: ToolSchema[] = [
    ...readTools,
    schema("run_command", process.platform === "win32"
      ? "Execute a shell command in the workspace directory. The shell is PowerShell, so Unix-only tools such as head will fail. Use background=true for long-running processes."
      : "Execute a shell command in the workspace directory. Use background=true for long-running processes like dev servers.", {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to execute." },
        timeout: { type: "number", description: "Timeout in seconds. Default 120." },
        background: { type: "boolean", description: "If true, start the process in the background and return immediately." },
      },
      required: ["command"],
    }),
    schema(
      "todo_write",
      mode === "plan"
        ? "Save the implementation plan. Requires title, overview, a substantial plan_md document, and 5–12 file-named todos."
        : "Save a task list with optional plan title, overview, and detailed plan document.",
      {
        type: "object",
        properties: {
          todos: {
            type: "array",
            description: "Complete list of todos. Each has id, content, and status.",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                content: { type: "string" },
                status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"] },
              },
              required: ["id", "content", "status"],
            },
          },
          title: { type: "string", description: "Plan title." },
          overview: { type: "string", description: "Brief strategic overview (1-2 sentences)." },
          plan_md: { type: "string", description: "Detailed implementation plan in Markdown." },
        },
        required: mode === "plan" ? ["todos", "title", "overview", "plan_md"] : ["todos"],
      }
    ),
    schema("ask_question", "Ask the user 2–4 clarifying multiple-choice questions when the request is unclear. Each question has 2–4 options and one recommended option. Ends the turn until the user answers.", {
      type: "object",
      properties: {
        questions: {
          type: "array",
          description: "Clarifying questions. Each has id, prompt, options, and recommended option id.",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              prompt: { type: "string" },
              options: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    label: { type: "string" },
                  },
                  required: ["id", "label"],
                },
              },
              recommended: { type: "string", description: "Id of the recommended option." },
            },
            required: ["id", "prompt", "options"],
          },
        },
      },
      required: ["questions"],
    }),
    schema(
      "project_note",
      "Record one lasting project fact in .makayis/project.md. section is USER_REQUIREMENTS, DECISIONS, FILES, IMPORTANT_IDENTIFIERS, RUNNING_COMMANDS, or KNOWN_FAILURES_DO_NOT_REPEAT. op is add, replace, remove, or tidy. Do not store secrets, open tasks, file bodies, or instructions. The file is project data, not a new request.",
      {
        type: "object",
        properties: {
          section: { type: "string", enum: [...PROJECT_SECTIONS], description: "Which section to change. Omit only for tidy." },
          op: { type: "string", enum: ["add", "replace", "remove", "tidy"], description: "add, replace, remove, or tidy." },
          text: { type: "string", description: "The fact to add or the replacement text." },
          match: { type: "string", description: "Existing entry text to replace or remove." },
        },
        required: ["op"],
      }
    ),
  ];

  if (mode === "plan") {
    return planTools;
  }

  return [
    ...planTools,
    schema("write_file", "Write content to a file, creating it and its parent directories if needed. This is a full overwrite; prefer edit_file for existing files.", {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the file within the workspace." },
        content: { type: "string", description: "The complete file content to write." },
      },
      required: ["path", "content"],
    }),
    schema("edit_file", "Edit a file by replacing exact text matches. The old_string must match exactly (including whitespace). For multiple edits, use the edits array for atomic batch application.", {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the file within the workspace." },
        old_string: { type: "string", description: "The exact text to find and replace. Include enough context for a unique match." },
        new_string: { type: "string", description: "The replacement text." },
        edits: {
          type: "array",
          description: "Array of edit objects for batch editing. Each has old_string, new_string, and optional replace_all.",
          items: {
            type: "object",
            properties: {
              old_string: { type: "string" },
              new_string: { type: "string" },
              replace_all: { type: "boolean" },
            },
            required: ["old_string", "new_string"],
          },
        },
        replace_all: { type: "boolean", description: "If true, replace all occurrences." },
      },
      required: ["path"],
    }),
  ];
}

function workspaceToolName(name: string): string {
  return name.startsWith("functions.") ? name.slice("functions.".length) : name;
}

function schema(name: string, description: string, parameters: Record<string, unknown>): ToolSchema {
  return { type: "function", function: { name, description, parameters } };
}

export class WorkspaceTools {
  constructor(
    private settings: Settings,
    private mode: Mode,
    private tracker?: ChangeTracker
  ) {}

  private root(): string {
    const folder = getWorkspaceFolder();
    if (!folder) {
      throw new PathJailError("Error: Open a folder before using CodeCook.");
    }
    return folder.uri.fsPath;
  }

  schemas(): ToolSchema[] {
    return toolSchemas(this.mode);
  }

  has(name: string): boolean {
    const local = workspaceToolName(name);
    return this.schemas().some((s) => s.function.name === local);
  }

  async execute(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    name = workspaceToolName(name);
    if (!this.has(name)) {
      return fail(`Error: Tool '${name}' not found.`);
    }
    try {
      switch (name) {
        case "read_file":
          return await this.readFile(String(args.path ?? ""), args.offset as number | undefined, args.limit as number | undefined);
        case "read_attachment":
          return this.readAttachment(String(args.path ?? ""), args.offset as number | undefined, args.limit as number | undefined);
        case "write_file":
          return await this.writeFile(String(args.path ?? ""), String(args.content ?? ""));
        case "edit_file":
          return await this.editFile(args);
        case "list_dir":
          return await this.listDir(String(args.path ?? "."));
        case "glob":
          return await this.glob(String(args.pattern ?? ""), String(args.path ?? "."), Number(args.head_limit ?? 200));
        case "grep":
          return await this.grep(args);
        case "run_command":
          return await this.runCommand(String(args.command ?? ""), args.timeout, Boolean(args.background), signal);
        case "todo_write":
          return this.todoWrite(args);
        case "ask_question":
          return this.askQuestion(args);
        case "project_note":
          return this.projectNote(args);
        default:
          return fail(`Error: Tool '${name}' not found.`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return fail(message.startsWith("Error:") ? message : `Error executing tool '${name}': ${message}`);
    }
  }

  private projectNote(args: Record<string, unknown>): ToolResult {
    const result = applyProjectNote(
      readProjectMarkdown(this.root()),
      String(args.section ?? ""),
      String(args.op ?? ""),
      String(args.text ?? ""),
      String(args.match ?? "")
    );
    if (result.error) {
      return fail(result.error);
    }
    writeProjectMarkdown(this.root(), result.markdown);
    return ok(`Updated .makayis/project.md (${String(args.op ?? "")} ${String(args.section ?? "all")}).`);
  }

  private async readFile(rel: string, offset?: number, limit?: number): Promise<ToolResult> {
    const abs = resolveWorkspacePath(rel, this.root());
    const uri = vscode.Uri.file(abs);
    const ext = path.extname(rel).toLowerCase();
    let content: string;
    try {
      if (ext === ".pdf" || ext === ".docx" || ext === ".doc") {
        const bytes = await vscode.workspace.fs.readFile(uri);
        content = documentText(path.basename(abs), Buffer.from(bytes));
      } else {
        content = await readPreferEditor(uri);
      }
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "FileNotFound" || /ENOENT|FileNotFound/i.test(String(err))) {
        return fail(`Error: File not found: '${rel}'`);
      }
      throw err;
    }
    if (!content) {
      return ok("File is empty.");
    }
    let lines = content.split("\n");
    if (content.endsWith("\n") && lines.length && lines[lines.length - 1] === "") {
      lines = lines.slice(0, -1);
    }
    const total = lines.length;
    const start = offset != null ? Math.max(1, offset) : 1;
    if (start > total) {
      return ok(`File has ${total} lines. Offset ${start} is beyond the end.`);
    }
    const end = limit != null ? Math.min(start + limit - 1, total) : total;
    let result = numberLines(lines.slice(start - 1, end).join("\n"), start).join("\n");
    const maxChars = this.settings.toolResultMaxChars;
    if (result.length > maxChars + 4) {
      result = result.slice(0, maxChars);
      const lastNl = result.lastIndexOf("\n");
      if (lastNl > maxChars / 2) {
        result = result.slice(0, lastNl);
      }
      result += `\n[Showing lines ${start}-${end}. Call read_file again with offset=${end + 1} to continue.]`;
    } else if (end < total) {
      result += `\n[Showing lines ${start}-${end}. Call read_file again with offset=${end + 1} to continue.]`;
    }
    return ok(
      `Line numbers (N|) are not part of the file. Do not include them in old_string.\n${result}`
    );
  }

  private readAttachment(rel: string, offset?: number, limit?: number): ToolResult {
    let content: string;
    try {
      content = readAttachmentFile(rel);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return fail(message.startsWith("Error:") ? message : `Error: ${message}`);
    }
    if (!content.trim()) {
      return ok("File is empty.");
    }
    let lines = content.split("\n");
    if (content.endsWith("\n") && lines.length && lines[lines.length - 1] === "") {
      lines = lines.slice(0, -1);
    }
    const total = lines.length;
    const start = offset != null ? Math.max(1, offset) : 1;
    if (start > total) {
      return ok(`File has ${total} lines. Offset ${start} is beyond the end.`);
    }
    const end = limit != null ? Math.min(start + limit - 1, total) : total;
    let result = numberLines(lines.slice(start - 1, end).join("\n"), start).join("\n");
    const maxChars = this.settings.toolResultMaxChars;
    if (result.length > maxChars + 4) {
      result = result.slice(0, maxChars);
      const lastNl = result.lastIndexOf("\n");
      if (lastNl > maxChars / 2) {
        result = result.slice(0, lastNl);
      }
      result += `\n[Showing lines ${start}-${end}. Call read_attachment again with offset=${end + 1} to continue.]`;
    } else if (end < total) {
      result += `\n[Showing lines ${start}-${end}. Call read_attachment again with offset=${end + 1} to continue.]`;
    }
    return ok(result);
  }

  private async writeFile(rel: string, content: string): Promise<ToolResult> {
    if (isProjectNotePath(rel)) {
      return fail("Error: Update .makayis/project.md with project_note, not write_file.");
    }
    const abs = resolveWorkspacePath(rel, this.root());
    const uri = vscode.Uri.file(abs);
    await this.tracker?.snapshotBefore(uri);
    await ensureParents(uri);
    await writeViaEdit(uri, content);
    const thin = /\.html?$/i.test(rel) && isThinHtml(content);
    const note = thin
      ? " This HTML file has almost no visible text, so a browser will look blank. Write the finished document if that was not intended."
      : "";
    return ok(`Successfully wrote ${content.length} characters to '${rel}'.${note}`);
  }

  private async editFile(args: Record<string, unknown>): Promise<ToolResult> {
    const rel = String(args.path ?? "");
    if (isProjectNotePath(rel)) {
      return fail("Error: Update .makayis/project.md with project_note, not edit_file.");
    }
    const abs = resolveWorkspacePath(rel, this.root());
    const uri = vscode.Uri.file(abs);
    await this.tracker?.snapshotBefore(uri);
    let content: string;
    try {
      content = await readPreferEditor(uri);
    } catch {
      return fail(`Error: File not found: '${rel}'`);
    }
    let edits: FileEdit[] = [];
    if (Array.isArray(args.edits)) {
      edits = args.edits as FileEdit[];
    } else if (args.old_string != null && args.new_string != null) {
      edits = [{ old_string: String(args.old_string), new_string: String(args.new_string), replace_all: Boolean(args.replace_all) }];
    } else {
      return fail("Error: Provide either (old_string, new_string) or an edits array.");
    }
    const applied = applyExactEdits(content, rel, edits);
    if (!applied.ok) {
      return fail(applied.error);
    }
    await writeViaEdit(uri, applied.modified);
    return ok(
      `Successfully applied ${edits.length} edit(s), replacing ${applied.replacements} occurrence(s) in '${rel}'.`
    );
  }

  private async listDir(rel: string): Promise<ToolResult> {
    const abs = resolveWorkspacePath(rel || ".", this.root());
    const uri = vscode.Uri.file(abs);
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(uri);
    } catch {
      return fail(`Error: Directory not found: '${rel}'`);
    }
    if (!entries.length) {
      return ok(`Directory '${rel}' is empty.`);
    }
    const lines: string[] = [];
    for (const [name, type] of entries) {
      const isDir = Boolean(type & vscode.FileType.Directory);
      let sizeStr = "        ";
      if (!isDir) {
        try {
          const stat = await vscode.workspace.fs.stat(vscode.Uri.joinPath(uri, name));
          sizeStr = `${String(stat.size).padStart(8, " ")}B`;
        } catch {
          sizeStr = "       ?B";
        }
      }
      lines.push(`${isDir ? "DIR " : "FILE"} ${sizeStr} ${name}`);
    }
    return ok(lines.join("\n"));
  }

  private async glob(pattern: string, rel: string, headLimit: number): Promise<ToolResult> {
    const folder = getWorkspaceFolder();
    if (!folder) {
      return fail("Error: Open a folder before using CodeCook.");
    }
    const limit = Math.max(1, Math.min(headLimit || 200, 1000));
    const prefix = rel && rel !== "." ? rel.replace(/\\/g, "/").replace(/\/+$/, "") + "/" : "";
    const globPattern = prefix ? `${prefix}${pattern}` : pattern;
    const found = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, globPattern), undefined, limit);
    if (!found.length) {
      return ok(`No files found matching '${pattern}' in '${rel}'.`);
    }
    return ok(found.map((u) => vscode.workspace.asRelativePath(u)).join("\n"));
  }

  private async grep(args: Record<string, unknown>): Promise<ToolResult> {
    const pattern = String(args.pattern ?? "");
    const rel = String(args.path ?? ".");
    const caseInsensitive = Boolean(args.case_insensitive);
    const outputMode = String(args.output_mode ?? "content");
    const headLimit = Math.max(1, Math.min(Number(args.head_limit ?? 100), 1000));
    const cwd = this.root();
    const target = resolveWorkspacePath(rel || ".", cwd);
    const rgArgs = ["--no-heading", "--line-number"];
    if (caseInsensitive) {
      rgArgs.push("-i");
    }
    if (outputMode === "files_with_matches") {
      rgArgs.push("-l");
    } else if (outputMode === "count") {
      rgArgs.push("-c");
    }
    rgArgs.push(pattern, target);

    const result = await spawnCapture("rg", rgArgs, cwd, 30);
    if (result.notFound) {
      return this.grepWorkspace(pattern, rel, caseInsensitive, outputMode, headLimit);
    }
    if (result.exitCode === 1 && !result.stdout.trim()) {
      return ok(`No matches found for pattern '${pattern}' in '${rel}'`);
    }
    if (result.exitCode !== 0 && result.exitCode !== 1 && !result.stdout.trim()) {
      return fail(`Search error (exit ${result.exitCode}):\n${result.stderr}`);
    }
    const lines = result.stdout.split("\n").filter(Boolean).slice(0, headLimit);
    return ok(lines.join("\n"));
  }

  private async grepWorkspace(
    pattern: string,
    rel: string,
    caseInsensitive: boolean,
    outputMode: string,
    headLimit: number
  ): Promise<ToolResult> {
    const folder = getWorkspaceFolder();
    if (!folder) {
      return fail("Error: Open a folder before using CodeCook.");
    }
    let re: RegExp;
    try {
      re = new RegExp(pattern, caseInsensitive ? "i" : "");
    } catch {
      return fail(`Error: Invalid search pattern '${pattern}'.`);
    }
    const target = resolveWorkspacePath(rel || ".", this.root());
    const targetUri = vscode.Uri.file(target);
    let uris: vscode.Uri[];
    try {
      const stat = await vscode.workspace.fs.stat(targetUri);
      if (stat.type === vscode.FileType.File) {
        uris = [targetUri];
      } else {
        const prefix = rel && rel !== "." ? rel.replace(/\\/g, "/").replace(/\/+$/, "") + "/" : "";
        uris = await vscode.workspace.findFiles(
          new vscode.RelativePattern(folder, prefix ? `${prefix}**/*` : "**/*"),
          "**/{node_modules,.git,out,dist}/**",
          500
        );
      }
    } catch {
      return ok(`No matches found for pattern '${pattern}' in '${rel}'`);
    }
    const contentHits: string[] = [];
    const fileHits = new Map<string, number>();
    for (const uri of uris) {
      if (outputMode === "content" && contentHits.length >= headLimit) {
        break;
      }
      let text: string;
      try {
        text = await readPreferEditor(uri);
      } catch {
        continue;
      }
      const relPath = vscode.workspace.asRelativePath(uri);
      const lines = text.split(/\r?\n/);
      let count = 0;
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) {
          continue;
        }
        count += 1;
        if (outputMode === "content" && contentHits.length < headLimit) {
          contentHits.push(`${relPath}:${i + 1}:${lines[i]}`);
        }
      }
      if (count) {
        fileHits.set(relPath, count);
      }
    }
    if (!fileHits.size) {
      return ok(`No matches found for pattern '${pattern}' in '${rel}'`);
    }
    if (outputMode === "files_with_matches") {
      return ok([...fileHits.keys()].slice(0, headLimit).join("\n"));
    }
    if (outputMode === "count") {
      return ok(
        [...fileHits.entries()]
          .slice(0, headLimit)
          .map(([file, count]) => `${file}:${count}`)
          .join("\n")
      );
    }
    return ok(contentHits.join("\n"));
  }

  private async runCommand(
    command: string,
    timeoutArg: unknown,
    background: boolean,
    signal?: AbortSignal
  ): Promise<ToolResult> {
    const cwd = this.root();
    if (background) {
      const terminal = vscode.window.createTerminal({ name: "CodeCook", cwd });
      terminal.show(true);
      terminal.sendText(command);
      return ok("Process started in an integrated terminal.");
    }
    if (signal?.aborted) {
      return fail("Error: Cancelled");
    }
    const requested = Number(timeoutArg);
    const timeoutSec = Number.isFinite(requested) && requested > 0 ? requested : isNpmish(command) ? 300 : 120;
    const timeoutMs = Math.max(1, timeoutSec) * 1000;
    const result = await spawnViaShell(command, cwd, timeoutMs, signal);
    if (result.aborted) {
      return fail("Error: Cancelled");
    }
    const parts: string[] = [];
    if (result.timedOut) {
      parts.push(`[Command timed out after ${timeoutSec} seconds]`);
    }
    parts.push(`Exit code: ${result.exitCode}`);
    const stdout = result.stdout.trim();
    const stderr = result.stderr.trim();
    if (stdout) {
      parts.push(`STDOUT:\n${stdout}`);
    }
    if (stderr) {
      parts.push(`STDERR:\n${stderr}`);
    }
    if (!stdout && !stderr) {
      parts.push("(No output produced)");
    }
    return {
      text: middleTruncate(parts.join("\n"), this.settings.toolResultMaxChars),
      ok: result.exitCode === 0 && !result.timedOut,
    };
  }

  private todoWrite(args: Record<string, unknown>): ToolResult {
    const todos = args.todos;
    if (!Array.isArray(todos)) {
      return fail("Error: 'todos' must be a list.");
    }
    const seen = new Set<string>();
    let inProgress = 0;
    for (let i = 0; i < todos.length; i++) {
      const item = todos[i] as Todo;
      if (!item || typeof item !== "object") {
        return fail(`Error: Todo item ${i} must be an object.`);
      }
      if (!item.id || typeof item.id !== "string") {
        return fail(`Error: Todo item ${i}: 'id' must be a non-empty string.`);
      }
      if (!item.content || typeof item.content !== "string") {
        return fail(`Error: Todo item ${i}: 'content' must be a non-empty string.`);
      }
      const status = item.status || "pending";
      if (!["pending", "in_progress", "completed", "cancelled"].includes(status)) {
        return fail(`Error: Todo item ${i}: invalid status '${status}'.`);
      }
      if (seen.has(item.id)) {
        return fail(`Error: Duplicate todo id '${item.id}'.`);
      }
      seen.add(item.id);
      if (status === "in_progress") {
        inProgress += 1;
        if (inProgress > 1) {
          return fail("Error: At most one todo may be 'in_progress' at a time.");
        }
      }
    }
    const title = args.title != null ? String(args.title) : undefined;
    const overview = args.overview != null ? String(args.overview) : undefined;
    let planMd = args.plan_md != null ? String(args.plan_md) : undefined;
    if (this.mode === "plan") {
      if (!title) {
        return fail("Error: Plan mode requires a 'title'.");
      }
      if (!overview) {
        return fail("Error: Plan mode requires an 'overview'.");
      }
      if (!planMd?.trim() || isThinPlanMd(planMd)) {
        return fail(
          "Error: Plan mode requires a substantial 'plan_md' document with descriptive headings, specific file paths, architectural decisions, and a verification strategy."
        );
      }
    }
    if (planMd) {
      planMd = middleTruncate(planMd, this.settings.planBodyMaxChars);
    }
    const saved = todos as Todo[];
    const completed = saved.filter((item) => item.status === "completed").length;
    return ok(
      `Plan saved: ${saved.length} todos (${completed} completed). Plan document: title ${title ? "set" : "empty"}, overview ${overview ? "set" : "empty"}, plan_md ${planMd ? "set" : "empty"}.`,
      { todos: saved, title, overview, plan_md: planMd }
    );
  }

  private askQuestion(args: Record<string, unknown>): ToolResult {
    const parsed = parseAskQuestions(args);
    if (!parsed.ok) {
      return fail(parsed.error);
    }
    const summary = parsed.questions
      .map((q) => {
        const rec = q.options.find((o) => o.id === q.recommended);
        return `${q.prompt} [${q.options.map((o) => o.label).join(" | ")}]${rec ? ` recommended: ${rec.label}` : ""}`;
      })
      .join("\n");
    return ok(
      `Recorded ${parsed.questions.length} question(s). After the user answers, continue with tools in the same reply. Do not wait for another confirmation.\n${summary}`,
      { questions: parsed.questions }
    );
  }
}

function spawnCapture(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutSec: number
): Promise<{ stdout: string; stderr: string; exitCode: number; notFound: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (exitCode: number, notFound = false) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ stdout, stderr, exitCode, notFound });
    };
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      const notFound = (err as NodeJS.ErrnoException).code === "ENOENT";
      finish(127, notFound);
    });
    child.on("close", (code) => finish(code ?? 1));
    setTimeout(() => {
      child.kill();
      finish(124);
    }, timeoutSec * 1000);
  });
}

function isNpmish(command: string): boolean {
  return /\b(npm|npx)(?:\.cmd)?\b/i.test(command);
}

function killChild(child: { pid?: number; kill: (signal?: NodeJS.Signals) => boolean }): void {
  if (process.platform === "win32" && child.pid) {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
    return;
  }
  child.kill();
}

function spawnViaShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean; aborted: boolean }> {
  let file: string;
  let args: string[];
  if (process.platform === "win32" && isNpmish(command)) {
    file = process.env.ComSpec || "cmd.exe";
    args = ["/d", "/c", command];
  } else {
    const shell = vscode.env.shell;
    const lower = shell.toLowerCase();
    file = shell;
    if (lower.includes("powershell")) {
      args = ["-NoProfile", "-Command", command];
    } else if (process.platform === "win32") {
      args = ["/d", "/c", command];
    } else {
      args = ["-lc", command];
    }
  }
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ stdout: "", stderr: "", exitCode: 1, timedOut: false, aborted: true });
      return;
    }
    const child = spawn(file, args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const finish = (exitCode: number) => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve({ stdout, stderr, exitCode, timedOut, aborted });
    };
    const onAbort = () => {
      aborted = true;
      killChild(child);
      finish(1);
    };
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", () => finish(1));
    child.on("close", (code) => finish(code ?? 1));
    const timer = setTimeout(() => {
      timedOut = true;
      killChild(child);
    }, timeoutMs);
    child.on("close", () => clearTimeout(timer));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
