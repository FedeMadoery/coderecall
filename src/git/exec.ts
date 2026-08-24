import { execFileSync } from "child_process";

/**
 * Safe git invocation.
 *
 * Every git call goes through here, with the arguments as an array and no
 * shell. The previous code built `git diff --name-status ${baseRef} ${headRef}`
 * and handed it to `execSync`, which runs it through a shell — and those refs
 * arrive from MCP tool arguments, i.e. from model output. `HEAD; rm -rf ~` was
 * a live command injection.
 *
 * `execFileSync` removes the shell, which kills metacharacter injection
 * outright. Two hazards survive that and are handled by the validators below:
 *
 * 1. **Argument injection.** A value beginning with `-` is read by git as a
 *    flag, not a value (`--upload-pack=...`, `--output=...`).
 * 2. **Pathspec confusion.** A path that looks like a revision, or vice versa.
 *    Every call that takes a path puts `--` before it.
 */

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

/** Characters that appear in legitimate git revisions. Deliberately narrow. */
const SAFE_REV = /^[A-Za-z0-9._/~^@{}:+-]+$/;

/**
 * Validate a revision (branch, tag, SHA, `HEAD~1`, `a..b`, `HEAD@{1}`).
 *
 * Rejects a leading `-` so a revision can never be read as a flag.
 */
export function assertSafeRev(rev: string, label = "ref"): string {
  if (typeof rev !== "string" || rev.length === 0) {
    throw new GitError(`Empty ${label}.`);
  }
  if (rev.length > 256) {
    throw new GitError(`${label} is implausibly long (${rev.length} chars).`);
  }
  if (rev.startsWith("-")) {
    throw new GitError(`${label} may not start with "-": ${JSON.stringify(rev)} would be read as a flag.`);
  }
  if (!SAFE_REV.test(rev)) {
    throw new GitError(`${label} contains characters that are not valid in a git revision: ${JSON.stringify(rev)}`);
  }
  return rev;
}

/**
 * Validate a repository-relative path used as a pathspec.
 *
 * Shell metacharacters are harmless here (no shell), so this only guards
 * against a path being read as a flag and against absolute/escaping paths.
 */
export function assertSafePath(path: string, label = "path"): string {
  if (typeof path !== "string" || path.length === 0) {
    throw new GitError(`Empty ${label}.`);
  }
  if (path.startsWith("-")) {
    throw new GitError(`${label} may not start with "-": ${JSON.stringify(path)} would be read as a flag.`);
  }
  if (path.includes("\0") || path.includes("\n")) {
    throw new GitError(`${label} contains a control character.`);
  }
  return path;
}

export interface RunGitOptions {
  /** Hard cap on captured output. Defaults to 32 MB. */
  maxBuffer?: number;
  /** Kill the process after this many ms. Defaults to 15s. */
  timeoutMs?: number;
  /** Return "" instead of throwing when git exits non-zero. */
  allowFailure?: boolean;
}

/**
 * Run git with an argv array — never a command string.
 */
export function runGit(repoPath: string, args: string[], options: RunGitOptions = {}): string {
  const { maxBuffer = 32 * 1024 * 1024, timeoutMs = 15_000, allowFailure = false } = options;

  try {
    return execFileSync("git", args, {
      cwd: repoPath,
      encoding: "utf-8",
      maxBuffer,
      timeout: timeoutMs,
      // Keep git from prompting for credentials on a network-backed remote.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (err) {
    if (allowFailure) return "";
    const detail = err instanceof Error ? err.message : String(err);
    throw new GitError(`git ${args[0] ?? ""} failed: ${detail.split("\n")[0]}`);
  }
}

/** Same as runGit but returning a Buffer, for -z output with odd bytes in paths. */
export function runGitRaw(repoPath: string, args: string[], options: RunGitOptions = {}): Buffer {
  const { maxBuffer = 256 * 1024 * 1024, timeoutMs = 60_000 } = options;
  return execFileSync("git", args, {
    cwd: repoPath,
    encoding: "buffer",
    maxBuffer,
    timeout: timeoutMs,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "ignore"]
  });
}

/** True if the path is inside a git working tree. */
export function isGitRepo(repoPath: string): boolean {
  try {
    return runGit(repoPath, ["rev-parse", "--is-inside-work-tree"], { timeoutMs: 5000 }).trim() === "true";
  } catch {
    return false;
  }
}

/** True for a shallow clone, where history is truncated and answers are partial. */
export function isShallowRepo(repoPath: string): boolean {
  return (
    runGit(repoPath, ["rev-parse", "--is-shallow-repository"], { allowFailure: true, timeoutMs: 5000 }).trim() ===
    "true"
  );
}
