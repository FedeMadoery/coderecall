import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { FileScanner } from "../src/indexer/scanner";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "coderecall-scan-"));
  mkdirSync(join(root, "frontend", "src", "api"), { recursive: true });
  mkdirSync(join(root, "backend", "svc"), { recursive: true });
  writeFileSync(join(root, "frontend", "src", "api", "client.ts"), "export const client = 1;\n");
  writeFileSync(join(root, "frontend", "src", "app.ts"), "export const app = 1;\n");
  writeFileSync(join(root, "backend", "svc", "client.ts"), "export const svc = 1;\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function scanner(base: string, projectRoot?: string) {
  // Temp dirs are not git repos, so this exercises the glob path.
  return new FileScanner(base, { extensions: [".ts"], useGit: false, projectRoot });
}

describe("scanned paths are relative to the project root", () => {
  test("a full scan records root-relative paths", async () => {
    const files = await scanner(root, root).scanAll();
    expect(files.map((f) => f.relativePath).sort()).toEqual([
      "backend/svc/client.ts",
      "frontend/src/api/client.ts",
      "frontend/src/app.ts"
    ]);
  });

  test("a scoped scan still records root-relative paths", async () => {
    // The bug: paths used to be relative to the scan base, so this recorded
    // "src/api/client.ts" — indistinguishable from a root-relative path, and
    // colliding with a genuine top-level src/api/client.ts.
    const files = await scanner(join(root, "frontend"), root).scanAll();
    expect(files.map((f) => f.relativePath).sort()).toEqual(["frontend/src/api/client.ts", "frontend/src/app.ts"]);
  });

  test("same-named files in different subtrees stay distinct", async () => {
    const front = await scanner(join(root, "frontend"), root).scanAll();
    const back = await scanner(join(root, "backend"), root).scanAll();

    const frontClient = front.find((f) => f.relativePath.endsWith("api/client.ts"))!;
    const backClient = back.find((f) => f.relativePath.endsWith("svc/client.ts"))!;

    expect(frontClient.relativePath).toBe("frontend/src/api/client.ts");
    expect(backClient.relativePath).toBe("backend/svc/client.ts");
    expect(frontClient.relativePath).not.toBe(backClient.relativePath);
  });

  test("omitting projectRoot keeps the old base-relative behaviour", async () => {
    // Back-compat for callers that scan a whole project and pass nothing.
    const files = await scanner(join(root, "frontend")).scanAll();
    expect(files.map((f) => f.relativePath).sort()).toEqual(["src/api/client.ts", "src/app.ts"]);
  });

  test("scanFiles resolves its input against the base but stores project-relative", async () => {
    const files = await scanner(join(root, "frontend"), root).scanFiles(["src/app.ts"]);
    expect(files).toHaveLength(1);
    expect(files[0]!.relativePath).toBe("frontend/src/app.ts");
    expect(files[0]!.content).toContain("export const app");
  });

  test("absolute path is still the real location on disk", async () => {
    const files = await scanner(join(root, "backend"), root).scanAll();
    expect(files[0]!.path).toBe(join(root, "backend", "svc", "client.ts"));
  });
});
