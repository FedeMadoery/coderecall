/**
 * Git-backed history search.
 *
 * No index, no embeddings, never stale — it asks git directly. That makes it
 * the one retrieval path in coderecall that cannot go out of date, which is
 * also why it is worth having alongside the index.
 *
 * Output is budgeted deliberately. `git log` on a large repo can emit
 * megabytes, and the point of this tool is to hand an agent something it can
 * afford to read: subject lines by default, full bodies only for a single
 * commit, blame windowed to a line range.
 */
import { assertSafePath, assertSafeRev, GitError, isGitRepo, isShallowRepo, runGit } from "./exec";

/** Field and record separators that cannot occur in a commit subject. */
const FS = "\x1f";
const RS = "\x1e";
const LOG_FORMAT = ["%H", "%h", "%an", "%aI", "%s"].join(FS) + RS;

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
export const MAX_BLAME_LINES = 200;
/** Commit bodies can be enormous; keep a single commit affordable to read. */
export const MAX_BODY_CHARS = 4000;

export interface CommitSummary {
  sha: string;
  shortSha: string;
  author: string;
  date: string;
  subject: string;
}

export interface BlameLine {
  shortSha: string;
  author: string;
  date: string;
  lineNumber: number;
  content: string;
}

export interface CommitDetail extends CommitSummary {
  body: string;
  bodyTruncated: boolean;
  stat: string;
}

export interface HistoryResult<T> {
  mode: string;
  entries: T[];
  /** True when results were cut off by the limit. */
  truncated: boolean;
  /** Set when the repo is shallow, so callers can say answers may be partial. */
  shallow: boolean;
}

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit) || limit < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

function parseCommits(raw: string): CommitSummary[] {
  return raw
    .split(RS)
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record.trim().length > 0)
    .map((record) => {
      const [sha = "", shortSha = "", author = "", date = "", subject = ""] = record.split(FS);
      return { sha, shortSha, author, date, subject };
    });
}

export class GitHistory {
  private repoPath: string;

  constructor(repoPath: string) {
    this.repoPath = repoPath;
  }

  /** Throw a clear error rather than a stack trace when there is no repo. */
  private requireRepo(): void {
    if (!isGitRepo(this.repoPath)) {
      throw new GitError(
        `Not a git repository: ${this.repoPath}. History search reads git directly, so it needs a working tree.`
      );
    }
  }

  private shallow(): boolean {
    return isShallowRepo(this.repoPath);
  }

  /**
   * Search commit messages.
   *
   * The query is matched literally (`--fixed-strings`), not as a regex: an
   * agent-supplied pattern is far more likely to contain incidental regex
   * metacharacters than to intend them.
   */
  searchCommits(query: string, limit?: number): HistoryResult<CommitSummary> {
    this.requireRepo();
    const n = clampLimit(limit);
    if (!query || query.trim().length === 0) {
      throw new GitError("Empty search query.");
    }

    const raw = runGit(this.repoPath, [
      "log",
      `--max-count=${n + 1}`,
      `--format=${LOG_FORMAT}`,
      "--fixed-strings",
      "--regexp-ignore-case",
      `--grep=${query}`
    ]);

    const all = parseCommits(raw);
    return { mode: "commits", entries: all.slice(0, n), truncated: all.length > n, shallow: this.shallow() };
  }

  /** Commits that touched a path, following renames. */
  fileHistory(path: string, limit?: number): HistoryResult<CommitSummary> {
    this.requireRepo();
    const n = clampLimit(limit);
    assertSafePath(path);

    const raw = runGit(this.repoPath, [
      "log",
      `--max-count=${n + 1}`,
      `--format=${LOG_FORMAT}`,
      "--follow",
      // Everything after -- is a path, so a path can never be read as a revision.
      "--",
      path
    ]);

    const all = parseCommits(raw);
    return { mode: "file_history", entries: all.slice(0, n), truncated: all.length > n, shallow: this.shallow() };
  }

  /**
   * Who last touched each line of a file, windowed to a line range.
   *
   * Without a window this would return the whole file, which defeats the point
   * of a budgeted tool, so it is capped either way.
   */
  blame(path: string, lineStart?: number, lineEnd?: number): HistoryResult<BlameLine> {
    this.requireRepo();
    assertSafePath(path);

    const args = ["blame", "--line-porcelain"];
    let capped = false;

    if (lineStart && lineStart > 0) {
      const end = lineEnd && lineEnd >= lineStart ? lineEnd : lineStart + MAX_BLAME_LINES - 1;
      const windowEnd = Math.min(end, lineStart + MAX_BLAME_LINES - 1);
      capped = windowEnd < end;
      args.push(`-L${lineStart},${windowEnd}`);
    } else {
      args.push(`-L1,${MAX_BLAME_LINES}`);
      capped = true;
    }

    args.push("--", path);

    const raw = runGit(this.repoPath, args);
    const entries: BlameLine[] = [];

    // --line-porcelain repeats a full header per line: a header line with the
    // sha, then key/value lines, then the content prefixed with a tab.
    let current: Partial<BlameLine> = {};
    for (const line of raw.split("\n")) {
      const shaMatch = line.match(/^([0-9a-f]{7,40})\s+\d+\s+(\d+)/);
      if (shaMatch) {
        current = { shortSha: shaMatch[1]!.slice(0, 8), lineNumber: Number(shaMatch[2]) };
        continue;
      }
      if (line.startsWith("author ")) {
        current.author = line.slice("author ".length);
        continue;
      }
      if (line.startsWith("author-time ")) {
        current.date = new Date(Number(line.slice("author-time ".length)) * 1000).toISOString();
        continue;
      }
      if (line.startsWith("\t")) {
        entries.push({
          shortSha: current.shortSha ?? "",
          author: current.author ?? "",
          date: current.date ?? "",
          lineNumber: current.lineNumber ?? 0,
          content: line.slice(1)
        });
        current = {};
      }
    }

    return { mode: "blame", entries, truncated: capped, shallow: this.shallow() };
  }

  /** One commit: metadata, message body, and a per-file change stat. */
  commitDetail(rev: string): HistoryResult<CommitDetail> {
    this.requireRepo();
    assertSafeRev(rev, "commit");

    // The trailing `--` matters: without it git can read a revision as a
    // pathspec and abort with "ambiguous argument".
    const raw = runGit(this.repoPath, ["show", "--no-patch", `--format=${LOG_FORMAT}%b`, rev, "--"]);
    const [head = "", ...bodyParts] = raw.split(RS);
    const [sha = "", shortSha = "", author = "", date = "", subject = ""] = head.split(FS);

    const fullBody = bodyParts.join(RS).trim();
    const body = fullBody.slice(0, MAX_BODY_CHARS);

    // Names and line counts only — never the diff content, which is unbounded.
    // `--stat` replaces the patch with a diffstat; `--no-patch` would suppress
    // the stat as well, which is how this first came back empty.
    const stat = runGit(this.repoPath, ["show", "--stat", "--format=", rev, "--"], {
      allowFailure: true
    }).trim();

    return {
      mode: "commit_detail",
      entries: [
        {
          sha,
          shortSha,
          author,
          date,
          subject,
          body,
          bodyTruncated: fullBody.length > MAX_BODY_CHARS,
          stat
        }
      ],
      truncated: false,
      shallow: this.shallow()
    };
  }
}
