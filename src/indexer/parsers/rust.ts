import type { LanguageParser, ParsedChunk } from "./types";

export class RustParser implements LanguageParser {
  readonly language = "rust";

  parse(code: string): ParsedChunk[] {
    const chunks: ParsedChunk[] = [];
    const lines = code.split("\n");

    let pendingDoc: string[] = [];
    let currentImpl: string | null = null;
    let implBraceDepth = -1;
    let braceDepth = 0;

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]!;
      const line = raw.trim();

      if (line.startsWith("///") || line.startsWith("//!")) {
        pendingDoc.push(line.replace(/^\/\/[!/]\s?/, ""));
        continue;
      }

      const openCount = (raw.match(/{/g) || []).length;
      const closeCount = (raw.match(/}/g) || []).length;

      // mod X
      const modMatch = line.match(/^(?:pub\s+)?mod\s+(\w+)/);
      if (modMatch && modMatch[1]) {
        const end = line.includes("{") ? findBraceEnd(lines, i) : i;
        chunks.push({
          chunk_type: "module",
          visibility: line.startsWith("pub") ? "public" : "private",
          name: modMatch[1],
          content: lines.slice(i, end + 1).join("\n"),
          start_line: i + 1,
          end_line: end + 1,
          parent_name: null,
          signature: line.replace(/\s*{.*$/, "").replace(/;\s*$/, ""),
          docstring: takeDoc(pendingDoc)
        });
        pendingDoc = [];
        braceDepth += openCount - closeCount;
        continue;
      }

      // struct / enum / trait
      const typeMatch = line.match(/^(?:pub\s+(?:\([^)]*\)\s+)?)?(struct|enum|trait)\s+(\w+)/);
      if (typeMatch && typeMatch[2]) {
        const end = line.includes("{") ? findBraceEnd(lines, i) : i;
        chunks.push({
          chunk_type: "class",
          visibility: line.startsWith("pub") ? "public" : "private",
          name: typeMatch[2],
          content: lines.slice(i, end + 1).join("\n"),
          start_line: i + 1,
          end_line: end + 1,
          parent_name: null,
          signature: line.replace(/\s*{.*$/, "").replace(/;\s*$/, ""),
          docstring: takeDoc(pendingDoc)
        });
        pendingDoc = [];
        braceDepth += openCount - closeCount;
        continue;
      }

      // impl Block
      const implMatch = line.match(/^impl(?:<[^>]+>)?\s+(?:[\w:<>'\s,]+\s+for\s+)?(\w+)/);
      if (implMatch && implMatch[1] && line.includes("{")) {
        currentImpl = implMatch[1];
        implBraceDepth = braceDepth + openCount;
        braceDepth += openCount - closeCount;
        pendingDoc = [];
        continue;
      }

      // fn name(...)
      const fnMatch = line.match(/^(?:pub\s+(?:\([^)]*\)\s+)?)?(?:async\s+)?(?:const\s+)?(?:unsafe\s+)?fn\s+(\w+)/);
      if (fnMatch && fnMatch[1]) {
        const end = line.includes("{") ? findBraceEnd(lines, i) : i;
        const isMethod = currentImpl !== null && braceDepth >= implBraceDepth;
        chunks.push({
          chunk_type: isMethod ? "method" : "function",
          visibility: line.startsWith("pub") ? "public" : "private",
          name: fnMatch[1],
          content: lines.slice(i, end + 1).join("\n"),
          start_line: i + 1,
          end_line: end + 1,
          parent_name: isMethod ? currentImpl : null,
          signature: line.replace(/\s*{.*$/, "").replace(/;\s*$/, ""),
          docstring: takeDoc(pendingDoc)
        });
        pendingDoc = [];
        braceDepth += openCount - closeCount;
        if (currentImpl !== null && braceDepth < implBraceDepth) {
          currentImpl = null;
          implBraceDepth = -1;
        }
        continue;
      }

      if (line) pendingDoc = [];
      braceDepth += openCount - closeCount;
      if (currentImpl !== null && braceDepth < implBraceDepth) {
        currentImpl = null;
        implBraceDepth = -1;
      }
    }

    return chunks;
  }
}

function takeDoc(buf: string[]): string | null {
  return buf.length ? buf.join("\n") : null;
}

function findBraceEnd(lines: string[], startLine: number): number {
  let depth = 0;
  let started = false;
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i] ?? "";
    for (const ch of line) {
      if (ch === "{") {
        depth++;
        started = true;
      } else if (ch === "}") {
        depth--;
        if (started && depth <= 0) return i;
      }
    }
  }
  return lines.length - 1;
}
