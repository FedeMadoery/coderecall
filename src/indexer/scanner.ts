import { glob } from "glob";
import { readFile } from "fs/promises";
import { join, extname } from "path";
import { execSync } from "child_process";
import { languageForExtension } from "./parsers";
import { DEFAULT_IGNORE } from "../config";

export interface ScannedFile {
  path: string;
  relativePath: string;
  content: string;
  language: string;
}

export interface FileScannerOptions {
  extensions?: string[];
  ignore?: string[];
}

export class FileScanner {
  private basePath: string;
  private extensions: string[];
  private ignore: string[];

  constructor(basePath: string, options: FileScannerOptions | string[] = {}) {
    this.basePath = basePath;
    // Back-compat: allow passing extensions array directly
    if (Array.isArray(options)) {
      this.extensions = options;
      this.ignore = DEFAULT_IGNORE;
    } else {
      this.extensions = options.extensions ?? [".ts", ".tsx", ".js", ".jsx"];
      this.ignore = options.ignore ?? DEFAULT_IGNORE;
    }
  }

  async scanAll(): Promise<ScannedFile[]> {
    const patterns = this.extensions.map((ext) => `**/*${ext}`);
    const files: ScannedFile[] = [];

    for (const pattern of patterns) {
      const matches = await glob(pattern, {
        cwd: this.basePath,
        ignore: this.ignore,
        absolute: false,
        dot: false
      });

      for (const match of matches) {
        const fullPath = join(this.basePath, match);
        const content = await readFile(fullPath, "utf-8");
        files.push({
          path: fullPath,
          relativePath: match,
          content,
          language: languageForExtension(extname(match))
        });
      }
    }

    return files;
  }

  async scanFiles(relativePaths: string[]): Promise<ScannedFile[]> {
    const files: ScannedFile[] = [];

    for (const relativePath of relativePaths) {
      const fullPath = join(this.basePath, relativePath);
      try {
        const content = await readFile(fullPath, "utf-8");
        files.push({
          path: fullPath,
          relativePath,
          content,
          language: languageForExtension(extname(relativePath))
        });
      } catch {
        // File might have been deleted
        console.warn(`Could not read file: ${relativePath}`);
      }
    }

    return files;
  }

  getChangedFiles(
    baseRef: string = "HEAD~1",
    headRef: string = "HEAD"
  ): {
    added: string[];
    modified: string[];
    deleted: string[];
  } {
    try {
      const output = execSync(`git diff --name-status ${baseRef} ${headRef}`, {
        cwd: this.basePath,
        encoding: "utf-8"
      });

      const added: string[] = [];
      const modified: string[] = [];
      const deleted: string[] = [];

      for (const line of output.split("\n")) {
        if (!line.trim()) continue;
        const [status, ...pathParts] = line.split("\t");
        const filePath = pathParts.join("\t");

        if (!this.extensions.some((ext) => filePath.endsWith(ext))) continue;

        switch (status) {
          case "A":
            added.push(filePath);
            break;
          case "M":
            modified.push(filePath);
            break;
          case "D":
            deleted.push(filePath);
            break;
          case "R":
            if (pathParts.length >= 2 && pathParts[0] && pathParts[1]) {
              deleted.push(pathParts[0]);
              added.push(pathParts[1]);
            }
            break;
        }
      }

      return { added, modified, deleted };
    } catch (err) {
      console.error("Failed to get git diff:", err);
      return { added: [], modified: [], deleted: [] };
    }
  }
}
