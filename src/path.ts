import * as path from "path";

export class PathJailError extends Error {}

export function resolveWorkspacePath(rel: string, rootFsPath: string): string {
  const raw = (rel || ".").replace(/\\/g, "/");
  if (path.win32.isAbsolute(raw) || path.posix.isAbsolute(raw)) {
    throw new PathJailError(`Error: Absolute paths are not allowed: '${rel}'`);
  }
  const normalized = path.posix.normalize(raw);
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new PathJailError(`Error: Path escapes the workspace: '${rel}'`);
  }
  const resolved = path.resolve(rootFsPath, normalized);
  const root = path.resolve(rootFsPath);
  const relToRoot = path.relative(root, resolved);
  if (relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) {
    throw new PathJailError(`Error: Path escapes the workspace: '${rel}'`);
  }
  return resolved;
}

export interface FileEdit {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

function toLf(text: string): string {
  return String(text ?? "").replace(/\r\n/g, "\n");
}

function stripReadPrefixes(text: string): string {
  return String(text ?? "")
    .split("\n")
    .map((line) => line.replace(/^\s*\d+\|\s?/, ""))
    .join("\n");
}

function withoutLineNumbers(edits: FileEdit[]): FileEdit[] {
  return edits.map((edit) => ({ ...edit, old_string: stripReadPrefixes(edit.old_string) }));
}

export function isThinHtml(html: string): boolean {
  const body = String(html ?? "").match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  const region = body ? body[1] : String(html ?? "");
  const text = region
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length < 40;
}

function fileNewline(text: string): "\r\n" | "\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function applyOn(
  content: string,
  filePath: string,
  edits: FileEdit[]
): { ok: true; modified: string; replacements: number } | { ok: false; error: string; index: number } {
  let modified = content;
  let total = 0;
  for (let i = 0; i < edits.length; i++) {
    const old = edits[i].old_string;
    const next = edits[i].new_string;
    const replaceAll = Boolean(edits[i].replace_all);
    if (old == null || next == null) {
      return { ok: false, index: i, error: `Error: Edit ${i}: old_string and new_string are required.` };
    }
    const count = modified.split(old).length - 1;
    if (count === 0) {
      return {
        ok: false,
        index: i,
        error: `Error: Edit ${i}: old_string not found in '${filePath}'.`,
      };
    }
    if (count > 1 && (old.length < 40 || count > 20)) {
      return {
        ok: false,
        index: i,
        error:
          `Error: Edit ${i}: old_string matches ${count} times in '${filePath}'. ` +
          "The snippet is too small. Do not set replace_all. Call read_file, then write_file with the full file.",
      };
    }
    if (count > 1 && !replaceAll) {
      return {
        ok: false,
        index: i,
        error:
          `Error: Edit ${i}: old_string matches ${count} times in '${filePath}'. ` +
          "Include more surrounding context to match exactly once, " +
          "or set replace_all to true if all occurrences should be replaced.",
      };
    }
    modified = replaceAll ? modified.split(old).join(next) : modified.replace(old, next);
    total += replaceAll ? count : 1;
  }
  return { ok: true, modified, replacements: total };
}

export function applyExactEdits(
  content: string,
  filePath: string,
  edits: FileEdit[]
): { ok: true; modified: string; replacements: number } | { ok: false; error: string } {
  const exact = applyOn(content, filePath, edits);
  if (exact.ok) {
    return exact;
  }
  if (exact.error.includes("required") || exact.error.includes("matches")) {
    return { ok: false, error: exact.error };
  }
  const stripped = withoutLineNumbers(edits);
  const prefixesChanged = stripped.some((edit, i) => edit.old_string !== edits[i].old_string);
  if (prefixesChanged) {
    const again = applyOn(content, filePath, stripped);
    if (again.ok) {
      return again;
    }
    if (again.error.includes("matches")) {
      return { ok: false, error: again.error };
    }
  }
  const nl = fileNewline(content);
  const lfEdits = (prefixesChanged ? stripped : edits).map((edit) => ({
    ...edit,
    old_string: toLf(edit.old_string),
    new_string: toLf(edit.new_string),
  }));
  const normalized = applyOn(toLf(content), filePath, lfEdits);
  if (normalized.ok) {
    return {
      ok: true,
      modified: nl === "\r\n" ? normalized.modified.replace(/\n/g, "\r\n") : normalized.modified,
      replacements: normalized.replacements,
    };
  }
  if (normalized.error.includes("matches")) {
    return { ok: false, error: normalized.error };
  }
  const preview = content
    .split(/\r?\n/)
    .slice(0, 40)
    .map((line, i) => `${i + 1}|${line}`)
    .join("\n");
  return {
    ok: false,
    error:
      `${exact.error} The file on disk did not match the text to replace ` +
      "(often a Windows CRLF vs LF mismatch, or the file changed after the last read). " +
      `Current start of '${filePath}':\n${preview}`,
  };
}
