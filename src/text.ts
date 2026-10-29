export function middleTruncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const removed = text.length - maxChars;
  const half = Math.floor(maxChars / 2);
  return `${text.slice(0, half)}\n\n[... truncated ${removed} characters ...]\n\n${text.slice(-half)}`;
}

export function numberLines(text: string, start = 1): string[] {
  let lines = text.split("\n");
  if (text.endsWith("\n") && lines.length && lines[lines.length - 1] === "") {
    lines = lines.slice(0, -1);
  }
  return lines.map((line, i) => `${String(i + start).padStart(6, " ")}| ${line}`);
}
