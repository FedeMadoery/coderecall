import type { LanguageParser, ParsedChunk } from "./types";

export class RubyParser implements LanguageParser {
  readonly language = "ruby";

  parse(code: string): ParsedChunk[] {
    const chunks: ParsedChunk[] = [];
    const lines = code.split("\n");
    const stack: string[] = [];
    let visibility: "public" | "private" = "public";

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (!line || line.startsWith("#")) continue;

      if (line === "private") {
        visibility = "private";
        continue;
      }
      if (line === "public") {
        visibility = "public";
        continue;
      }

      const classMatch = line.match(/^(class|module)\s+([\w:]+)/);
      if (classMatch && classMatch[2]) {
        const end = findEnd(lines, i);
        chunks.push({
          chunk_type: classMatch[1] === "module" ? "module" : "class",
          visibility: "public",
          name: classMatch[2],
          content: lines.slice(i, end + 1).join("\n"),
          start_line: i + 1,
          end_line: end + 1,
          parent_name: stack.length ? stack[stack.length - 1]! : null,
          signature: line,
          docstring: null
        });
        stack.push(classMatch[2]);
        visibility = "public";
        continue;
      }

      const defMatch = line.match(/^def\s+(?:self\.)?(\w+[!?=]?)/);
      if (defMatch && defMatch[1]) {
        const end = findEnd(lines, i);
        chunks.push({
          chunk_type: stack.length ? "method" : "function",
          visibility,
          name: defMatch[1],
          content: lines.slice(i, end + 1).join("\n"),
          start_line: i + 1,
          end_line: end + 1,
          parent_name: stack.length ? stack[stack.length - 1]! : null,
          signature: line,
          docstring: null
        });
        continue;
      }

      if (line === "end" && stack.length) stack.pop();
    }

    return chunks;
  }
}

function findEnd(lines: string[], startLine: number): number {
  let depth = 0;
  let started = false;
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i]?.trim() ?? "";
    if (
      /^(class|module|def|do|if|unless|while|until|case|begin)\b/.test(line) ||
      /\bdo\s*(\|[^|]*\|)?\s*$/.test(line)
    ) {
      depth++;
      started = true;
    }
    if (line === "end" || line.startsWith("end ") || line.endsWith(" end")) {
      depth--;
      if (started && depth <= 0) return i;
    }
  }
  return lines.length - 1;
}
