import fs from "fs";
import path from "path";
import os from "os";

export interface WorkerConfig {
  port: number;
  ollamaHost: string;
  defaultModel: string;
  defaultThink: boolean;
  defaultCtx: number;
  defaultMaxTokens: number;
  // Defense in depth: the worker can NEVER touch a path outside these roots,
  // regardless of what the calling client passes as workspace_root. Empty
  // by default -- you must explicitly opt a directory in via the config UI
  // or this file before file tools do anything.
  allowedRoots: string[];
  webSearchEnabled: boolean;
}

export const DEFAULT_CONFIG: WorkerConfig = {
  port: 8787,
  ollamaHost: "http://localhost:11434",
  defaultModel: "qwen3.6:35b-a3b",
  defaultThink: false,
  defaultCtx: 32768,
  defaultMaxTokens: 4096,
  allowedRoots: [],
  webSearchEnabled: true,
};

const CONFIG_DIR = path.join(os.homedir(), ".local-worker-mcp");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
export const LOG_PATH = path.join(CONFIG_DIR, "activity.log");

export function loadConfig(): WorkerConfig {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return { ...DEFAULT_CONFIG };
  }
  const onDisk = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  return { ...DEFAULT_CONFIG, ...onDisk };
}

export function saveConfig(cfg: WorkerConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

export function appendLog(line: string): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${line}\n`);
}

/** Resolve a path relative to a workspace_root, refusing anything that
 * escapes the configured allowedRoots (defense in depth against a
 * misbehaving or manipulated worker trying e.g. "../../../etc/passwd"). */
export function resolveSafePath(cfg: WorkerConfig, workspaceRoot: string, relativePath: string): string {
  const root = path.resolve(workspaceRoot);
  const isAllowed = cfg.allowedRoots.some((allowed) => {
    const resolvedAllowed = path.resolve(allowed);
    return root === resolvedAllowed || root.startsWith(resolvedAllowed + path.sep);
  });
  if (!isAllowed) {
    throw new Error(
      `workspace_root "${root}" is not in allowedRoots. Add it via the config UI or ~/.local-worker-mcp/config.json first.`
    );
  }
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Path "${relativePath}" escapes workspace_root "${root}" -- refused.`);
  }
  return resolved;
}
