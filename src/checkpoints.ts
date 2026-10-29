import type { Plan, Todo } from "./types";

export interface CheckpointFile {
  fsPath: string;
  rel: string;
  before: string;
  created: boolean;
}

export interface Checkpoint {
  seq: number;
  files: CheckpointFile[];
  plan?: Plan | null;
  todos?: Todo[] | null;
}

export function restoreFiles(checkpoints: Checkpoint[], targetSeq: number): CheckpointFile[] {
  const earliest = new Map<string, { seq: number; file: CheckpointFile }>();
  for (const checkpoint of checkpoints) {
    if (checkpoint.seq < targetSeq) {
      continue;
    }
    for (const file of checkpoint.files) {
      const prev = earliest.get(file.fsPath);
      if (!prev || checkpoint.seq < prev.seq) {
        earliest.set(file.fsPath, { seq: checkpoint.seq, file });
      }
    }
  }
  return [...earliest.values()].map((entry) => entry.file);
}
