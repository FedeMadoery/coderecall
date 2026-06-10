import type { LanguageParser, ParsedChunk } from "./types";

/**
 * Indentation-based Python parser. Detects:
 *  - class definitions
 *  - def / async def (visibility = "private" when name starts with "_")
 *  - triple-quoted docstrings immediately following the header
 */
export class PythonParser implements LanguageParser {
  readonly language = "python";

  parse(code: string): ParsedChunk[] {
    const chunks: ParsedChunk[] = [];
    const lines = code.split("\n");
    const stack: { name: string; indent: number; type: "class" | "def" }[] = [];

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]!;
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const indent = raw.match(/^\s*/)?.[0].length ?? 0;

      while (stack.length > 0 && indent <= stack[stack.length - 1]!.indent) {
        stack.pop();
      }

      const classMatch = trimmed.match(/^class\s+(\w+)\s*(\([^)]*\))?\s*:/);
      if (classMatch && classMatch[1]) {
        const name = classMatch[1];
        const end = findBlockEnd(lines, i, indent);
        const docstring = extractDocstring(lines, i + 1, indent + 4);
        chunks.push({
          chunk_type: "class",
          visibility: name.startsWith("_") ? "private" : "public",
          name,
          content: lines.slice(i, end + 1).join("\n"),
          start_line: i + 1,
          end_line: end + 1,
          parent_name: stack.length ? stack[stack.length - 1]!.name : null,
          signature: trimmed.replace(/:\s*$/, ""),
          docstring
        });
        stack.push({ name, indent, type: "class" });
        continue;
      }

      const defMatch = trimmed.match(/^(async\s+)?def\s+(\w+)\s*\(/);
      if (defMatch && defMatch[2]) {
        const name = defMatch[2];
        const end = findBlockEnd(lines, i, indent);
        const parent = stack.length ? stack[stack.length - 1] : null;
        const docstring = extractDocstring(lines, i + 1, indent + 4);
        chunks.push({
          chunk_type: parent?.type === "class" ? "method" : "function",
          visibility: name.startsWith("_") ? "private" : "public",
          name,
          content: lines.slice(i, end + 1).join("\n"),
          start_line: i + 1,
          end_line: end + 1,
          parent_name: parent?.name ?? null,
          signature: trimmed.replace(/:\s*$/, ""),
          docstring
        });
        stack.push({ name, indent, type: "def" });
      }
    }

    return chunks;
  }
}

function findBlockEnd(lines: string[], startLine: number, headerIndent: number): number {
  for (let i = startLine + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.trim()) continue;
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (indent <= headerIndent) return i - 1;
  }
  return lines.length - 1;
}

function extractDocstring(lines: string[], from: number, bodyIndent: number): string | null {
  // Find first non-blank line in body
  for (let i = from; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (indent < bodyIndent) return null;
    const m = line.trim().match(/^(?:r|b|rb|br|u)?("""|''')(.*)/);
    if (!m) return null;
    const delim = m[1]!;
    const rest = m[2]!;
    if (rest.includes(delim)) {
      return rest.slice(0, rest.indexOf(delim)).trim() || null;
    }
    const buf: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (l.includes(delim)) {
        buf.push(l.slice(0, l.indexOf(delim)));
        return buf.join("\n").trim() || null;
      }
      buf.push(l);
    }
    return null;
  }
  return null;
}
