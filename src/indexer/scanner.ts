import { glob } from "glob";
import { readFile } from "fs/promises";
import { dirname, join, extname } from "path";
import { execSync } from "child_process";
import { languageForExtension } from "./parsers";
import { DEFAULT_IGNORE } from "../config";
import { minimatch } from "minimatch";

export interface ScannedFile {
  path: string;
  relativePath: string;
  content: string;
  language: string;
}

export interface FileScannerOptions {
  extensions?: string[];
  ignore?: string[];
  /** If false, skip `git ls-files` even when in a git repo. Default true. */
  useGit?: boolean;
}

export class FileScanner {
  private basePath: string;
  private extensions: string[];
  private ignore: string[];
  private useGit: boolean;

  constructor(basePath: string, options: FileScannerOptions | string[] = {}) {
    this.basePath = basePath;
    // Back-compat: allow passing extensions array directly
    if (Array.isArray(options)) {
      this.extensions = options;
      this.ignore = DEFAULT_IGNORE;
      this.useGit = true;
    } else {
      this.extensions = options.extensions ?? [".ts", ".tsx", ".js", ".jsx"];
      this.ignore = options.ignore ?? DEFAULT_IGNORE;
      this.useGit = options.useGit ?? true;
    }
  }

  async scanAll(): Promise<ScannedFile[]> {
    if (this.useGit && this.isGitRepo()) {
      console.error("Scanning via git ls-files (respects .gitignore)");
      return this.scanViaGit();
    }
    console.error("Scanning via glob (no git repo or --no-git-ls)");
    return this.scanViaGlob();
  }

  /** True if basePath is inside a git working tree. */
  private isGitRepo(): boolean {
    try {
      execSync("git rev-parse --is-inside-work-tree", {
        cwd: this.basePath,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"]
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Enumerate via git: tracked files + untracked-not-ignored. */
  private async scanViaGit(): Promise<ScannedFile[]> {
    // -z separates with NUL so paths with newlines/quotes are safe.
    const out = execSync(
      "git ls-files -z --cached --others --exclude-standard",
      { cwd: this.basePath, encoding: "buffer", maxBuffer: 256 * 1024 * 1024 }
    );

    const paths = out
      .toString("utf-8")
      .split("\0")
      .filter(Boolean);

    const extSet = new Set(this.extensions);
    const candidates = paths.filter(
      (p) => extSet.has(extname(p)) && !this.isIgnored(p)
    );

    return this.readFiles(candidates);
  }

  /** Glob-based fallback. For Python projects, pre-scans for pyvenv.cfg to ignore venvs by content, not name. */
  private async scanViaGlob(): Promise<ScannedFile[]> {
    const extraIgnore = this.hasPythonExtensions() ? await this.detectVenvDirs() : [];
    if (extraIgnore.length > 0) {
      console.error(`Detected ${extraIgnore.length} Python venv(s) via pyvenv.cfg; ignoring.`);
    }
    const effectiveIgnore = [...this.ignore, ...extraIgnore];

    const patterns = this.extensions.map((ext) => `**/*${ext}`);
    const matched: string[] = [];

    for (const pattern of patterns) {
      const matches = await glob(pattern, {
        cwd: this.basePath,
        ignore: effectiveIgnore,
        absolute: false,
        dot: false
      });
      matched.push(...matches);
    }

    return this.readFiles(matched);
  }

  /** True if any of the configured extensions belong to Python. */
  private hasPythonExtensions(): boolean {
    const pythonExts = new Set([".py", ".pyi", ".pyx", ".pyw"]);
    return this.extensions.some((ext) => pythonExts.has(ext));
  }

  /** Find every `pyvenv.cfg` and return `<containing-dir>/**` globs. */
  private async detectVenvDirs(): Promise<string[]> {
    const matches = await glob("**/pyvenv.cfg", {
      cwd: this.basePath,
      ignore: this.ignore,
      absolute: false,
      dot: true
    });
    return matches.map((m) => {
      const dir = dirname(m);
      return dir === "." ? "**" : `${dir}/**`;
    });
  }

  /** Match a relative path against the configured ignore globs. */
  private isIgnored(relativePath: string): boolean {
    for (const pattern of this.ignore) {
      if (minimatch(relativePath, pattern, { dot: true, matchBase: false })) {
        return true;
      }
    }
    return false;
  }

  /** Read file contents for a list of relative paths. */
  private async readFiles(relativePaths: string[]): Promise<ScannedFile[]> {
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
        // Symlink target missing, binary file, or transient I/O error — skip quietly.
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
