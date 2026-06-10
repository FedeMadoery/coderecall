import { extname } from "path";
import type { LanguageParser } from "./types";
import { ElixirParser } from "./elixir";
import { TypeScriptParser } from "./typescript";
import { PythonParser } from "./python";
import { GoParser } from "./go";
import { RustParser } from "./rust";
import { RubyParser } from "./ruby";
import { GenericParser } from "./generic";

export { ElixirParser, TypeScriptParser, PythonParser, GoParser, RustParser, RubyParser, GenericParser };
export type { LanguageParser, ParsedChunk } from "./types";

const REGISTRY = new Map<string, () => LanguageParser>([
  [".ex", () => new ElixirParser()],
  [".exs", () => new ElixirParser()],
  [".ts", () => new TypeScriptParser("typescript")],
  [".tsx", () => new TypeScriptParser("typescript")],
  [".js", () => new TypeScriptParser("javascript")],
  [".jsx", () => new TypeScriptParser("javascript")],
  [".mjs", () => new TypeScriptParser("javascript")],
  [".cjs", () => new TypeScriptParser("javascript")],
  [".py", () => new PythonParser()],
  [".go", () => new GoParser()],
  [".rs", () => new RustParser()],
  [".rb", () => new RubyParser()]
]);

const LANGUAGES = new Map<string, string>([
  [".ex", "elixir"],
  [".exs", "elixir"],
  [".ts", "typescript"],
  [".tsx", "typescript"],
  [".js", "javascript"],
  [".jsx", "javascript"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
  [".py", "python"],
  [".go", "go"],
  [".rs", "rust"],
  [".rb", "ruby"]
]);

export function getParserForFile(filepath: string): LanguageParser {
  const ext = extname(filepath).toLowerCase();
  const factory = REGISTRY.get(ext);
  if (factory) return factory();
  return new GenericParser(languageForExtension(ext));
}

export function languageForExtension(ext: string): string {
  return LANGUAGES.get(ext.toLowerCase()) || "unknown";
}

export function supportedExtensions(): string[] {
  return Array.from(REGISTRY.keys());
}
