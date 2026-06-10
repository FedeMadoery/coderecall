import { mkdirSync } from "fs";
import { join, resolve, isAbsolute } from "path";
import { CoderecallServer } from "./mcp/server";
import { loadConfig } from "./config";

const projectRoot = resolve(process.env.CODERECALL_PROJECT_ROOT || process.cwd());
const config = loadConfig(projectRoot);

const indexPath = isAbsolute(config.indexPath)
  ? config.indexPath
  : join(projectRoot, config.indexPath);

const dbPath = join(indexPath, "index.db");

try {
  mkdirSync(indexPath, { recursive: true });
} catch {
  // Directory might already exist
}

const server = new CoderecallServer(dbPath, config);

process.on("SIGINT", () => {
  server.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  server.close();
  process.exit(0);
});

server.run().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
