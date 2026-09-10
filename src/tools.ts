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
    {
      type: "function",
      function: {
        name: "run_script",
        description:
          "Run a script file you already wrote (via write_file) using an allow-listed interpreter -- " +
          `${Object.keys(ALLOWED_INTERPRETERS).join(", ")}. Use this to actually verify non-npm/TS projects ` +
          "(Python, plain Node scripts, etc.) instead of guessing that code works. This does NOT run arbitrary " +
          "shell commands or shell strings -- only 'interpreter <script_path> [args...]', no pipes, no &&, no " +
          `shell expansion. Capped at ${MAX_SCRIPT_RUNS_PER_TASK} uses per task.`,
        parameters: {
          type: "object",
          properties: {
            interpreter: { type: "string", enum: Object.keys(ALLOWED_INTERPRETERS) },
            script_path: { type: "string", description: "Path to the script, relative to workspace_root." },
            args: { type: "array", items: { type: "string" }, description: "Optional plain arguments passed to the script." },
          },
          required: ["interpreter", "script_path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "run_checks",
        description:
          "Verify your own work by running project checks (build / typecheck / test) inside workspace_root. " +
          "This does NOT run arbitrary commands -- only these three fixed, safe checks. Use this before declaring " +
          `a coding task done, and to see whether a fix actually worked. Capped at ${MAX_CHECKS_PER_TASK} uses per ` +
          "task -- if checks still fail after that, STOP and report the failure honestly instead of retrying " +
          "the same thing again.",
        parameters: {
          type: "object",
          properties: {
            checks: {
              type: "array",
              items: { type: "string", enum: ["build", "typecheck", "test"] },
              description: "Which checks to run. 'build' = npm run build, 'typecheck' = npx tsc --noEmit, 'test' = npm test.",
            },
          },
          required: ["checks"],
        },
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

export const MAX_CHECKS_PER_TASK = 4;
const ALLOWED_CHECKS: Record<string, { cmd: string; args: string[]; timeoutMs: number }> = {
  build: { cmd: "npm", args: ["run", "build"], timeoutMs: 120_000 },
  typecheck: { cmd: "npx", args: ["tsc", "--noEmit"], timeoutMs: 60_000 },
  test: { cmd: "npm", args: ["test"], timeoutMs: 120_000 },
};

// The gap this closes: run_checks only knows npm/TS. A benchmark head-to-head
// against DeepSeek Harness's real `bash` tool (2026-09-10) showed the worker
// writing correct Python, then burning its whole run_checks budget retrying
// `npm run build` against a project with no package.json, and finally telling
// the HUMAN to verify it manually instead of ever running the code itself.
// run_script fixes that without opening arbitrary shell: fixed interpreter
// allow-list, no shell string, script_path resolved through the same
// resolveSafePath as every other file tool.
export const MAX_SCRIPT_RUNS_PER_TASK = 4;
const ALLOWED_INTERPRETERS: Record<string, { cmd: string; timeoutMs: number }> = {
  python3: { cmd: "python3", timeoutMs: 60_000 },
  node: { cmd: "node", timeoutMs: 60_000 },
  ruby: { cmd: "ruby", timeoutMs: 60_000 },
};

export interface ToolContext {
  config: WorkerConfig;
  workspaceRoot: string;
  // Mutable, one instance per delegate_task call (see ollama.ts) -- caps how
  // many times run_checks can fire in a single task so a confused model
  // can't loop "fix -> check -> fix -> check -> ..." forever. maxSteps in
  // the outer tool-calling loop is a backstop too, but this gives a much
  // tighter, purpose-specific limit and a clearer message when it's hit.
  checksUsed: { count: number };
  scriptRunsUsed: { count: number };
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
    case "run_checks": {
      return await runChecks(args.checks, ctx);
    }
    case "run_script": {
      return await runScript(args.interpreter, args.script_path, args.args || [], ctx);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function runChecks(checks: string[], ctx: ToolContext): Promise<string> {
  ctx.checksUsed.count++;
  if (ctx.checksUsed.count > MAX_CHECKS_PER_TASK) {
    return (
      `ERROR: run_checks has already been called ${ctx.checksUsed.count - 1} times this task ` +
      `(limit ${MAX_CHECKS_PER_TASK}). Stop retrying the same fix -- report the current failure and stop.`
    );
  }

  const root = resolveSafePath(ctx.config, ctx.workspaceRoot, ".");
  const results: string[] = [];

  for (const check of checks) {
    const spec = ALLOWED_CHECKS[check];
    if (!spec) {
      results.push(`${check}: ERROR unknown check (allowed: ${Object.keys(ALLOWED_CHECKS).join(", ")})`);
      continue;
    }
    try {
      const { stdout, stderr } = await execFileAsync(spec.cmd, spec.args, {
        cwd: root,
        timeout: spec.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      });
      const output = (stdout + stderr).trim();
      results.push(`${check}: PASS${output ? "\n" + truncate(output) : ""}`);
    } catch (e: any) {
      const output = ((e.stdout || "") + (e.stderr || "") || e.message || String(e)).trim();
      results.push(`${check}: FAIL\n${truncate(output)}`);
    }
  }

  appendLog(`RUN_CHECKS [${checks.join(",")}] workspace_root=${ctx.workspaceRoot} (use ${ctx.checksUsed.count}/${MAX_CHECKS_PER_TASK})`);
  return results.join("\n\n");
}

async function runScript(interpreter: string, scriptPath: string, scriptArgs: string[], ctx: ToolContext): Promise<string> {
  ctx.scriptRunsUsed.count++;
  if (ctx.scriptRunsUsed.count > MAX_SCRIPT_RUNS_PER_TASK) {
    return (
      `ERROR: run_script has already been called ${ctx.scriptRunsUsed.count - 1} times this task ` +
      `(limit ${MAX_SCRIPT_RUNS_PER_TASK}). Stop retrying the same fix -- report the current failure and stop.`
    );
  }

  const spec = ALLOWED_INTERPRETERS[interpreter];
  if (!spec) {
    return `ERROR: unknown interpreter "${interpreter}" (allowed: ${Object.keys(ALLOWED_INTERPRETERS).join(", ")})`;
  }
  if (typeof scriptPath !== "string" || !scriptPath.trim()) {
    return "ERROR: script_path is required";
  }
  if (!scriptArgs.every((a) => typeof a === "string")) {
    return "ERROR: args must be plain strings";
  }

  // resolveSafePath both confines the script to workspace_root/allowedRoots
  // AND rejects it if it doesn't exist as a real file -- same guarantee
  // read_file already relies on, so a model can't point this at anything
  // outside its sandbox.
  const absPath = resolveSafePath(ctx.config, ctx.workspaceRoot, scriptPath);
  if (!fs.existsSync(absPath)) {
    return `ERROR: script not found at ${scriptPath}`;
  }

  const root = resolveSafePath(ctx.config, ctx.workspaceRoot, ".");
  try {
    // execFile, never a shell string -- args after the script path are
    // passed as an argv array, so there is no pipe/&&/expansion surface
    // even though the model chooses their content.
    const { stdout, stderr } = await execFileAsync(spec.cmd, [absPath, ...scriptArgs], {
      cwd: root,
      timeout: spec.timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    const output = (stdout + stderr).trim();
    appendLog(`RUN_SCRIPT ${interpreter} ${scriptPath} workspace_root=${ctx.workspaceRoot} (use ${ctx.scriptRunsUsed.count}/${MAX_SCRIPT_RUNS_PER_TASK}) -> PASS`);
    return `PASS (exit 0)${output ? "\n" + truncate(output) : ""}`;
  } catch (e: any) {
    const output = ((e.stdout || "") + (e.stderr || "") || e.message || String(e)).trim();
    appendLog(`RUN_SCRIPT ${interpreter} ${scriptPath} workspace_root=${ctx.workspaceRoot} (use ${ctx.scriptRunsUsed.count}/${MAX_SCRIPT_RUNS_PER_TASK}) -> FAIL`);
    return `FAIL (exit ${e.code ?? "?"})\n${truncate(output)}`;
  }
}

function truncate(s: string, max = 4000): string {
  return s.length > max ? s.slice(0, max) + `\n... (truncated, ${s.length - max} more chars)` : s;
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
