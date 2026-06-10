import type { LanguageParser, ParsedChunk } from "./types";

export class GoParser implements LanguageParser {
  readonly language = "go";

  parse(code: string): ParsedChunk[] {
    const chunks: ParsedChunk[] = [];
    const lines = code.split("\n");

    let pendingDoc: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]!;
      const line = raw.trim();

      if (line.startsWith("//")) {
        pendingDoc.push(line.replace(/^\/\/\s?/, ""));
        continue;
      }

      // type X struct / type X interface
      const typeMatch = line.match(/^type\s+(\w+)\s+(struct|interface)\b/);
      if (typeMatch && typeMatch[1]) {
        const name = typeMatch[1];
        const end = findBraceEnd(lines, i);
        chunks.push({
          chunk_type: "class",
          visibility: /^[A-Z]/.test(name) ? "public" : "private",
          name,
          content: lines.slice(i, end + 1).join("\n"),
          start_line: i + 1,
          end_line: end + 1,
          parent_name: null,
          signature: line.replace(/\s*{.*$/, ""),
          docstring: takeDoc(pendingDoc)
        });
        pendingDoc = [];
        continue;
      }

      // func (recv T) Name(...)  -> method
      const methodMatch = line.match(/^func\s+\(\s*\w+\s+\*?(\w+)\s*\)\s+(\w+)\s*\(/);
      if (methodMatch && methodMatch[1] && methodMatch[2]) {
        const end = findBraceEnd(lines, i);
        chunks.push({
          chunk_type: "method",
          visibility: /^[A-Z]/.test(methodMatch[2]) ? "public" : "private",
          name: methodMatch[2],
          content: lines.slice(i, end + 1).join("\n"),
          start_line: i + 1,
          end_line: end + 1,
          parent_name: methodMatch[1],
          signature: line.replace(/\s*{.*$/, ""),
          docstring: takeDoc(pendingDoc)
        });
        pendingDoc = [];
        continue;
      }

      // func Name(...)
      const funcMatch = line.match(/^func\s+(\w+)\s*\(/);
      if (funcMatch && funcMatch[1]) {
        const end = findBraceEnd(lines, i);
        chunks.push({
          chunk_type: "function",
          visibility: /^[A-Z]/.test(funcMatch[1]) ? "public" : "private",
          name: funcMatch[1],
          content: lines.slice(i, end + 1).join("\n"),
          start_line: i + 1,
          end_line: end + 1,
          parent_name: null,
          signature: line.replace(/\s*{.*$/, ""),
          docstring: takeDoc(pendingDoc)
        });
        pendingDoc = [];
        continue;
      }

      if (line) pendingDoc = [];
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
