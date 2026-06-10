import type { LanguageParser, ParsedChunk } from "./types";

export class ElixirParser implements LanguageParser {
  readonly language = "elixir";

  parse(code: string): ParsedChunk[] {
    const chunks: ParsedChunk[] = [];
    const lines = code.split("\n");

    let currentModule: string | null = null;
    let currentDocstring: string | null = null;
    let docBuffer: string[] = [];
    let inDoc = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const trimmed = line.trim();

      if (trimmed.startsWith("@doc") || trimmed.startsWith("@moduledoc")) {
        inDoc = true;
        docBuffer = [];
        if (trimmed.includes('"""')) {
          const parts = trimmed.split('"""');
          if (parts.length >= 3) {
            currentDocstring = parts[1] ?? null;
            inDoc = false;
          }
        }
        continue;
      }

      if (inDoc) {
        if (trimmed.includes('"""')) {
          currentDocstring = docBuffer.join("\n");
          inDoc = false;
        } else {
          docBuffer.push(trimmed);
        }
        continue;
      }

      const moduleMatch = trimmed.match(/^defmodule\s+([\w.]+)/);
      if (moduleMatch && moduleMatch[1]) {
        currentModule = moduleMatch[1];
        const endLine = findBlockEnd(lines, i);
        chunks.push({
          chunk_type: "module",
          visibility: "public",
          name: currentModule,
          content: lines.slice(i, endLine + 1).join("\n"),
          start_line: i + 1,
          end_line: endLine + 1,
          parent_name: null,
          signature: `defmodule ${currentModule}`,
          docstring: currentDocstring
        });
        currentDocstring = null;
        continue;
      }

      const funcMatch = trimmed.match(/^(def|defp)\s+(\w+)/);
      if (funcMatch && funcMatch[1] && funcMatch[2]) {
        const visibility = funcMatch[1] === "defp" ? "private" : "public";
        const endLine = findBlockEnd(lines, i);
        chunks.push({
          chunk_type: "function",
          visibility,
          name: funcMatch[2],
          content: lines.slice(i, endLine + 1).join("\n"),
          start_line: i + 1,
          end_line: endLine + 1,
          parent_name: currentModule,
          signature: trimmed.replace(/\s+do\s*$/, ""),
          docstring: currentDocstring
        });
        currentDocstring = null;
      }
    }

    return chunks;
  }
}

function findBlockEnd(lines: string[], startLine: number): number {
  let depth = 0;
  let started = false;

  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i]?.trim() ?? "";
    if (line.match(/\b(do|fn)\b/) || line.endsWith("do")) {
      depth++;
      started = true;
    }
    if (line === "end" || line.startsWith("end ") || line.endsWith("end")) {
      depth--;
      if (started && depth <= 0) return i;
    }
  }

  return lines.length - 1;
}
