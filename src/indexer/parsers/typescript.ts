import type { LanguageParser, ParsedChunk } from "./types";

/**
 * Regex-based TS/JS parser. Covers the common shapes:
 *  - class declarations + methods
 *  - top-level function declarations
 *  - exported `const fn = (...) =>` arrow functions
 *  - interface / type alias declarations (as "module"-ish blocks)
 *
 * For deep accuracy you'd want tree-sitter; this is the pragmatic baseline.
 */
export class TypeScriptParser implements LanguageParser {
  readonly language: string;

  constructor(language: "typescript" | "javascript" = "typescript") {
    this.language = language;
  }

  parse(code: string): ParsedChunk[] {
    const chunks: ParsedChunk[] = [];
    const lines = code.split("\n");

    let pendingDoc: string | null = null;
    let docBuffer: string[] = [];
    let inDoc = false;
    let currentClass: string | null = null;
    let classBraceDepth = -1;
    let braceDepth = 0;

    const flushDoc = () => {
      const d = pendingDoc;
      pendingDoc = null;
      return d;
    };

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]!;
      const line = raw.trim();

      // JSDoc / block comments
      if (line.startsWith("/**")) {
        inDoc = true;
        docBuffer = [];
        if (line.endsWith("*/")) {
          pendingDoc = stripJsDoc(line);
          inDoc = false;
        }
        continue;
      }
      if (inDoc) {
        if (line.endsWith("*/")) {
          pendingDoc = stripJsDoc(docBuffer.join("\n"));
          inDoc = false;
        } else {
          docBuffer.push(line);
        }
        continue;
      }

      // Track braces for class scope
      const openCount = (raw.match(/{/g) || []).length;
      const closeCount = (raw.match(/}/g) || []).length;

      // class declaration
      const classMatch = line.match(/^(?:export\s+(?:default\s+)?|default\s+)?(?:abstract\s+)?class\s+(\w+)/);
      if (classMatch && classMatch[1]) {
        const name = classMatch[1];
        const end = findBraceEnd(lines, i);
        chunks.push({
          chunk_type: "class",
          visibility: line.includes("export") ? "public" : "private",
          name,
          content: lines.slice(i, end + 1).join("\n"),
          start_line: i + 1,
          end_line: end + 1,
          parent_name: null,
          signature: line.replace(/\s*{.*$/, ""),
          docstring: flushDoc()
        });
        currentClass = name;
        classBraceDepth = braceDepth + openCount;
        braceDepth += openCount - closeCount;
        continue;
      }

      // interface / type
      const ifaceMatch = line.match(/^(?:export\s+)?(interface|type)\s+(\w+)/);
      if (ifaceMatch && ifaceMatch[2]) {
        const end = ifaceMatch[1] === "interface" ? findBraceEnd(lines, i) : i;
        chunks.push({
          chunk_type: "module",
          visibility: line.includes("export") ? "public" : "private",
          name: ifaceMatch[2],
          content: lines.slice(i, end + 1).join("\n"),
          start_line: i + 1,
          end_line: end + 1,
          parent_name: null,
          signature: line.replace(/\s*{.*$/, "").replace(/;\s*$/, ""),
          docstring: flushDoc()
        });
        braceDepth += openCount - closeCount;
        continue;
      }

      // top-level / method function declarations
      // Patterns: function foo(...), async function foo(...), public foo(...), private foo(...), foo(...) {
      const funcMatch =
        line.match(/^(?:export\s+(?:default\s+)?|default\s+)?(?:async\s+)?function\*?\s+(\w+)\s*\(/) ||
        (currentClass ? line.match(/^(?:public|private|protected|static|async|\s)*\s*(\w+)\s*\([^)]*\)\s*[:{]/) : null);

      if (
        funcMatch &&
        funcMatch[1] &&
        funcMatch[1] !== "if" &&
        funcMatch[1] !== "for" &&
        funcMatch[1] !== "while" &&
        funcMatch[1] !== "switch" &&
        funcMatch[1] !== "catch"
      ) {
        const name = funcMatch[1];
        const end = findBraceEnd(lines, i);
        const isMethod = currentClass !== null && braceDepth >= classBraceDepth;
        const visibility = /\bprivate\b|^\s*#/.test(line) ? "private" : "public";
        chunks.push({
          chunk_type: isMethod ? "method" : "function",
          visibility,
          name,
          content: lines.slice(i, end + 1).join("\n"),
          start_line: i + 1,
          end_line: end + 1,
          parent_name: isMethod ? currentClass : null,
          signature: line.replace(/\s*{.*$/, "").replace(/\s*=>.*$/, ""),
          docstring: flushDoc()
        });
        braceDepth += openCount - closeCount;
        if (currentClass !== null && braceDepth < classBraceDepth) {
          currentClass = null;
          classBraceDepth = -1;
        }
        continue;
      }

      // arrow function: export const foo = (...) =>
      const arrowMatch = line.match(
        /^(?:export\s+(?:default\s+)?)?(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>/
      );
      if (arrowMatch && arrowMatch[1]) {
        const end = line.includes("{") ? findBraceEnd(lines, i) : i;
        chunks.push({
          chunk_type: "function",
          visibility: line.includes("export") ? "public" : "private",
          name: arrowMatch[1],
          content: lines.slice(i, end + 1).join("\n"),
          start_line: i + 1,
          end_line: end + 1,
          parent_name: null,
          signature: line.replace(/\s*{.*$/, "").replace(/\s*=>.*$/, " =>"),
          docstring: flushDoc()
        });
        braceDepth += openCount - closeCount;
        continue;
      }

      braceDepth += openCount - closeCount;
      if (currentClass !== null && braceDepth < classBraceDepth) {
        currentClass = null;
        classBraceDepth = -1;
      }
    }

    return chunks;
  }
}

function stripJsDoc(text: string): string {
  return text
    .replace(/\/\*\*/g, "")
    .replace(/\*\//g, "")
    .split("\n")
    .map((l) => l.trim().replace(/^\*\s?/, ""))
    .filter(Boolean)
    .join("\n");
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
