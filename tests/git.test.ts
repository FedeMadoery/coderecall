import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { assertSafePath, assertSafeRev, GitError, isGitRepo, runGit } from "../src/git/exec";
import { GitHistory, MAX_BLAME_LINES, MAX_LIMIT } from "../src/git/history";
import { FileScanner } from "../src/indexer/scanner";

let repo: string;
let notRepo: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "coderecall-git-"));
  runGit(repo, ["init", "-q", "--initial-branch=main"]);
  runGit(repo, ["config", "user.email", "test@example.com"]);
  runGit(repo, ["config", "user.name", "Test User"]);
  runGit(repo, ["config", "commit.gpgsign", "false"]);

  writeFileSync(join(repo, "alpha.ts"), "export const a = 1;\n");
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-q", "-m", "feat: add alpha"]);

  writeFileSync(join(repo, "alpha.ts"), "export const a = 1;\nexport const b = 2;\n");
  writeFileSync(join(repo, "beta.ts"), "export const c = 3;\n");
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-q", "-m", "fix: extend alpha and add beta"]);

  notRepo = mkdtempSync(join(tmpdir(), "coderecall-nogit-"));
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(notRepo, { recursive: true, force: true });
});

describe("argument validation", () => {
  test("a revision that would be read as a flag is rejected", () => {
    expect(() => assertSafeRev("--upload-pack=evil")).toThrow(GitError);
    expect(() => assertSafeRev("-n")).toThrow(/read as a flag/);
  });

  test("shell metacharacters are rejected in revisions", () => {
    for (const bad of ["HEAD; touch /tmp/pwned", "HEAD && ls", "HEAD | cat", "$(whoami)", "HEAD`id`"]) {
      expect(() => assertSafeRev(bad)).toThrow(GitError);
    }
  });

  test("legitimate revisions are accepted", () => {
    for (const good of [
      "HEAD",
      "HEAD~1",
      "HEAD@{1}",
      "main",
      "refs/heads/main",
      "v1.2.3",
      "a1b2c3d",
      "a..b",
      "a...b"
    ]) {
      expect(assertSafeRev(good)).toBe(good);
    }
  });

  test("empty and absurdly long revisions are rejected", () => {
    expect(() => assertSafeRev("")).toThrow(GitError);
    expect(() => assertSafeRev("a".repeat(300))).toThrow(/long/);
  });

  test("paths that would be read as flags are rejected", () => {
    expect(() => assertSafePath("--output=/tmp/x")).toThrow(/read as a flag/);
    expect(assertSafePath("ok/path.ts")).toBe("ok/path.ts");
  });
});

describe("command injection", () => {
  test("an injected command in a git ref does not execute", () => {
    // This was live: getChangedFiles interpolated refs into a shell command,
    // and those refs arrive from MCP tool arguments, i.e. model output.
    const marker = join(tmpdir(), `coderecall-pwned-${process.pid}`);
    if (existsSync(marker)) rmSync(marker);

    const scanner = new FileScanner(repo, { extensions: [".ts"] });
    expect(() => scanner.getChangedFiles(`HEAD; touch ${marker}`, "HEAD")).toThrow(GitError);

    expect(existsSync(marker)).toBe(false);
  });

  test("a rejected ref throws instead of reporting 'nothing changed'", () => {
    // Silently returning empty would have index_diff report 0 added / 0
    // modified and call it a success.
    const scanner = new FileScanner(repo, { extensions: [".ts"] });
    expect(() => scanner.getChangedFiles("--evil", "HEAD")).toThrow(GitError);
  });

  test("valid refs still work", () => {
    const scanner = new FileScanner(repo, { extensions: [".ts"] });
    const changed = scanner.getChangedFiles("HEAD~1", "HEAD");
    expect(changed.modified).toContain("alpha.ts");
    expect(changed.added).toContain("beta.ts");
  });
});

describe("history search", () => {
  test("searches commit messages", () => {
    const result = new GitHistory(repo).searchCommits("alpha");
    expect(result.entries.length).toBe(2);
    expect(result.entries[0]!.subject).toContain("extend alpha");
    expect(result.entries[0]!.author).toBe("Test User");
  });

  test("the query is literal, not a regex", () => {
    // A stray metacharacter should find nothing rather than match everything.
    expect(new GitHistory(repo).searchCommits("alpha.*beta").entries).toHaveLength(0);
  });

  test("lists commits touching one file", () => {
    const result = new GitHistory(repo).fileHistory("alpha.ts");
    expect(result.entries.length).toBe(2);
    expect(new GitHistory(repo).fileHistory("beta.ts").entries).toHaveLength(1);
  });

  test("blames a line range", () => {
    const result = new GitHistory(repo).blame("alpha.ts", 1, 2);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]!.lineNumber).toBe(1);
    expect(result.entries[0]!.content).toBe("export const a = 1;");
    expect(result.entries[0]!.author).toBe("Test User");
  });

  test("blame without a range is capped rather than dumping the file", () => {
    const result = new GitHistory(repo).blame("alpha.ts");
    expect(result.truncated).toBe(true);
    expect(result.entries.length).toBeLessThanOrEqual(MAX_BLAME_LINES);
  });

  test("returns one commit's detail with a stat and no diff body", () => {
    const result = new GitHistory(repo).commitDetail("HEAD");
    const commit = result.entries[0]!;
    expect(commit.subject).toContain("extend alpha");
    expect(commit.stat).toContain("alpha.ts");
    // A stat, never the patch — patches are unbounded.
    expect(commit.stat).not.toContain("export const");
  });

  test("limits are clamped to the documented maximum", () => {
    const result = new GitHistory(repo).searchCommits("a", 10_000);
    expect(result.entries.length).toBeLessThanOrEqual(MAX_LIMIT);
  });

  test("truncation is reported rather than hidden", () => {
    const result = new GitHistory(repo).fileHistory("alpha.ts", 1);
    expect(result.entries).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  test("an empty query is rejected", () => {
    expect(() => new GitHistory(repo).searchCommits("   ")).toThrow(GitError);
  });
});

describe("outside a git repository", () => {
  test("isGitRepo is false and history explains itself", () => {
    expect(isGitRepo(notRepo)).toBe(false);
    expect(() => new GitHistory(notRepo).searchCommits("anything")).toThrow(/Not a git repository/);
  });

  test("a path with no history yields an empty result, not a crash", () => {
    const result = new GitHistory(repo).fileHistory("does/not/exist.ts");
    expect(result.entries).toEqual([]);
    expect(result.truncated).toBe(false);
  });
});
