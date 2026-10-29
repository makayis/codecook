function flattenEvents(value: unknown): unknown[] {
  if (value == null) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap(flattenEvents);
  }
  return [value];
}

function parseSseChunk(raw: string): unknown[] {
  const events: unknown[] = [];
  for (const block of raw.split(/\n\n+/)) {
    const dataLines = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());
    if (!dataLines.length) {
      continue;
    }
    const payload = dataLines.join("\n");
    if (!payload || payload === "[DONE]") {
      continue;
    }
    try {
      events.push(...flattenEvents(JSON.parse(payload)));
    } catch {
      // Partial JSON is handled by the caller buffer.
    }
  }
  return events;
}

export function extractJsonArrayObjects(raw: string): unknown[] {
  const events: unknown[] = [];
  const s = raw.trim();
  let i = 0;
  if (s.startsWith("[")) {
    i = 1;
  }
  while (i < s.length) {
    while (i < s.length && (s[i] === "," || /\s/.test(s[i]))) {
      i += 1;
    }
    if (i >= s.length) {
      break;
    }
    if (s[i] === "]") {
      i += 1;
      continue;
    }
    if (s[i] !== "{") {
      break;
    }
    let depth = 0;
    let inStr = false;
    let esc = false;
    const start = i;
    for (; i < s.length; i += 1) {
      const c = s[i];
      if (inStr) {
        if (esc) {
          esc = false;
          continue;
        }
        if (c === "\\") {
          esc = true;
          continue;
        }
        if (c === '"') {
          inStr = false;
        }
        continue;
      }
      if (c === '"') {
        inStr = true;
        continue;
      }
      if (c === "{") {
        depth += 1;
      } else if (c === "}") {
        depth -= 1;
        if (depth === 0) {
          i += 1;
          try {
            events.push(JSON.parse(s.slice(start, i)));
          } catch {
            // Skip a malformed object.
          }
          break;
        }
      }
    }
    if (depth !== 0) {
      break;
    }
  }
  return events;
}

export function mergeTextPieces(pieces: string[]): string {
  let out = "";
  for (const piece of pieces) {
    if (!piece) {
      continue;
    }
    if (!out) {
      out = piece;
      continue;
    }
    if (piece.startsWith(out)) {
      out = piece;
      continue;
    }
    if (out.startsWith(piece) || out.endsWith(piece)) {
      continue;
    }
    out += piece;
  }
  return out;
}

export function parseVertexStream(raw: string): unknown[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.includes("data:")) {
    const sse = parseSseChunk(trimmed.endsWith("\n\n") ? trimmed : `${trimmed}\n\n`);
    if (sse.length) {
      return sse;
    }
  }
  try {
    return flattenEvents(JSON.parse(trimmed));
  } catch {
    const objects = extractJsonArrayObjects(trimmed);
    if (objects.length) {
      return objects;
    }
    const events: unknown[] = [];
    for (const line of trimmed.split(/\n+/)) {
      const piece = line.trim().replace(/^,/, "").replace(/,$/, "");
      if (!piece || piece === "[" || piece === "]") {
        continue;
      }
      try {
        events.push(...flattenEvents(JSON.parse(piece)));
      } catch {
        // Incomplete incremental JSON object.
      }
    }
    return events;
  }
}
