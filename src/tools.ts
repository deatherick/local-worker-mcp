import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { WorkerConfig, resolveSafePath, appendLog } from "./config.js";

const execFileAsync = promisify(execFile);

// Tool definitions in Ollama's OpenAI-compatible function-calling format.
export function buildToolDefs(webSearchEnabled: boolean) {
  const defs: any[] = [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a text file's contents, relative to workspace_root.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_dir",
        description: "List files and subdirectories at a path relative to workspace_root.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Defaults to workspace_root itself if omitted." } },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description: "Write (create or overwrite) a text file, relative to workspace_root. Every write is logged for audit.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_current_datetime",
        description: "Get the current real date/time (not the model's training cutoff).",
        parameters: { type: "object", properties: {} },
      },
    },
  ];
  if (webSearchEnabled) {
    defs.push({
      type: "function",
      function: {
        name: "search_web",
        description: "Search the web (DuckDuckGo) for current information.",
        parameters: {
          type: "object",
          properties: { query: { type: "string" }, limit: { type: "number" } },
          required: ["query"],
        },
      },
    });
  }
  return defs;
}

export interface ToolContext {
  config: WorkerConfig;
  workspaceRoot: string;
}

export async function executeTool(name: string, args: any, ctx: ToolContext): Promise<string> {
  switch (name) {
    case "read_file": {
      const p = resolveSafePath(ctx.config, ctx.workspaceRoot, args.path);
      return fs.readFileSync(p, "utf8");
    }
    case "list_dir": {
      const p = resolveSafePath(ctx.config, ctx.workspaceRoot, args.path || ".");
      const entries = fs.readdirSync(p, { withFileTypes: true });
      return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join("\n");
    }
    case "write_file": {
      const p = resolveSafePath(ctx.config, ctx.workspaceRoot, args.path);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, args.content);
      appendLog(`WRITE ${p} (${args.content.length} bytes) workspace_root=${ctx.workspaceRoot}`);
      return `Wrote ${args.content.length} bytes to ${args.path}`;
    }
    case "get_current_datetime": {
      const now = new Date();
      return JSON.stringify({ iso_utc: now.toISOString(), unix_epoch_seconds: Math.floor(now.getTime() / 1000) });
    }
    case "search_web": {
      return await searchWeb(args.query, args.limit || 5);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// Reuses the same well-tested no-API-key search backend as the Continue MCP
// setup (open-websearch), invoked once per call via npx rather than kept
// running as a side daemon -- simplest thing that works for v1. If latency
// becomes an issue, switch to a long-lived child process talking over its
// HTTP mode instead.
async function searchWeb(query: string, limit: number): Promise<string> {
  const script = `
    const payload = ${JSON.stringify({ query, limit, engines: ["duckduckgo"] })};
    import("http").then(() => {});
  `;
  // Simplest reliable approach: shell out to the open-websearch HTTP mode
  // briefly is overkill for a single call; instead call its underlying
  // DuckDuckGo HTML endpoint directly would require reimplementing parsing.
  // Pragmatic choice for v1: spawn `npx open-websearch@latest` in stdio MCP
  // mode for exactly one request/response, then let it exit.
  const { spawn } = await import("child_process");
  return new Promise((resolve, reject) => {
    const proc = spawn("npx", ["-y", "open-websearch@latest"], {
      env: { ...process.env, MODE: "stdio" },
    });
    let buf = "";
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        proc.kill();
        reject(new Error("search_web timed out"));
      }
    }, 30_000);

    proc.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 2 && msg.result) {
            resolved = true;
            clearTimeout(timeout);
            proc.kill();
            resolve(msg.result.content[0].text);
            return;
          }
        } catch {
          /* partial line, keep buffering */
        }
      }
    });
    proc.on("error", (e) => {
      clearTimeout(timeout);
      reject(e);
    });

    const send = (obj: any) => proc.stdin.write(JSON.stringify(obj) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "local-worker-mcp", version: "1.0" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search", arguments: { query, limit, engines: ["duckduckgo"] } } });
  });
}
