import { glob } from "glob";
import { readFile } from "fs/promises";
import { dirname, join, extname, relative, sep } from "path";
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
  /**
   * Root that stored paths are expressed relative to. Defaults to `basePath`.
   *
   * Set this whenever the scan covers a subdirectory: without it, scanning
   * `<root>/frontend` records `src/api/foo.ts` rather than
   * `frontend/src/api/foo.ts`, so a scoped index writes paths that collide with
   * root-relative ones and cannot be told apart afterwards.
   */
  projectRoot?: string;
}

export class FileScanner {
  private basePath: string;
  private extensions: string[];
  private ignore: string[];
  private useGit: boolean;
  /** Stored paths are relative to this, not necessarily to basePath. */
  private projectRoot: string;

  constructor(basePath: string, options: FileScannerOptions | string[] = {}) {
    this.basePath = basePath;
    // Back-compat: allow passing extensions array directly
    if (Array.isArray(options)) {
      this.extensions = options;
      this.ignore = DEFAULT_IGNORE;
      this.useGit = true;
      this.projectRoot = basePath;
    } else {
      this.extensions = options.extensions ?? [".ts", ".tsx", ".js", ".jsx"];
      this.ignore = options.ignore ?? DEFAULT_IGNORE;
      this.useGit = options.useGit ?? true;
      this.projectRoot = options.projectRoot ?? basePath;
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
    const out = execSync("git ls-files -z --cached --others --exclude-standard", {
      cwd: this.basePath,
      encoding: "buffer",
      maxBuffer: 256 * 1024 * 1024
    });

    const paths = out.toString("utf-8").split("\0").filter(Boolean);

    const extSet = new Set(this.extensions);
    const candidates = paths.filter((p) => extSet.has(extname(p)) && !this.isIgnored(p));

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

  /**
   * Read file contents for paths relative to `basePath`, storing each path
   * relative to `projectRoot` so scoped and full scans agree on identity.
   */
  private async readFiles(baseRelativePaths: string[]): Promise<ScannedFile[]> {
    const files: ScannedFile[] = [];
    for (const baseRelative of baseRelativePaths) {
      const fullPath = join(this.basePath, baseRelative);
      try {
        const content = await readFile(fullPath, "utf-8");
        files.push({
          path: fullPath,
          relativePath: this.toProjectRelative(fullPath),
          content,
          language: languageForExtension(extname(baseRelative))
        });
      } catch {
        // Symlink target missing, binary file, or transient I/O error — skip quietly.
      }
    }
    return files;
  }

  /** Normalise an absolute path to a project-root-relative, forward-slashed path. */
  private toProjectRelative(fullPath: string): string {
    return relative(this.projectRoot, fullPath).split(sep).join("/");
  }

  async scanFiles(baseRelativePaths: string[]): Promise<ScannedFile[]> {
    const files: ScannedFile[] = [];

    for (const baseRelative of baseRelativePaths) {
      const fullPath = join(this.basePath, baseRelative);
      try {
        const content = await readFile(fullPath, "utf-8");
        files.push({
          path: fullPath,
          relativePath: this.toProjectRelative(fullPath),
          content,
          language: languageForExtension(extname(baseRelative))
        });
      } catch {
        // File might have been deleted
        console.warn(`Could not read file: ${baseRelative}`);
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
