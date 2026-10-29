import * as path from "path";
import { middleTruncate } from "./text";
import type { Mention } from "./types";

export type { Mention };

export interface MentionFileText {
  text: string;
  binary: boolean;
}

const MAX_MENTIONS = 8;
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

export function isBinaryMention(name: string, bytes: Buffer): boolean {
  const ext = path.extname(name).toLowerCase();
  if (IMAGE_EXT.has(ext)) {
    return true;
  }
  return bytes.subarray(0, Math.min(bytes.length, 8000)).includes(0);
}

export function buildMentionBlocks(
  mentions: Mention[],
  activeRel: string | undefined,
  readText: (rel: string) => MentionFileText | undefined,
  maxChars: number
): string {
  const active = normalizeRel(activeRel);
  const seen = new Set<string>();
  const blocks: string[] = [];
  for (const mention of mentions.slice(0, MAX_MENTIONS)) {
    if (mention.kind === "terminal") {
      blocks.push(
        `--- Terminal selection ---\n${middleTruncate(mention.text || "", maxChars)}\n--- End terminal selection ---`
      );
      continue;
    }
    if (mention.kind === "selection") {
      const rel = normalizeRel(mention.path) || mention.label;
      blocks.push(
        `--- Mentioned file: ${rel} ---\n${mention.label}\n${middleTruncate(mention.text || "", maxChars)}\n--- End context file ---`
      );
      continue;
    }
    const rel = normalizeRel(mention.path || mention.label);
    if (!rel || (active && rel === active) || seen.has(rel)) {
      continue;
    }
    seen.add(rel);
    const loaded = readText(rel);
    const body = !loaded || loaded.binary ? rel : middleTruncate(loaded.text, maxChars);
    blocks.push(`--- Mentioned file: ${rel} ---\n${body}\n--- End context file ---`);
  }
  return blocks.join("\n\n");
}

function normalizeRel(rel: string | undefined): string {
  return String(rel || "").replace(/\\/g, "/").replace(/^\.\//, "");
}
