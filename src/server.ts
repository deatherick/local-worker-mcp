import express from "express";
import { randomUUID } from "crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig, saveConfig, WorkerConfig } from "./config.js";
import { runDelegatedTask } from "./ollama.js";

let config = loadConfig();

function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "local-worker-mcp", version: "0.1.0" });

  server.registerTool(
    "delegate_task",
    {
      description:
        "Delegate a scoped, well-specified task to a local Ollama model, which runs its own tool-calling loop " +
        "(read/list/write files under workspace_root, search the web, get current datetime) until done. " +
        "Use for mechanical/bulk work you can verify afterward -- not for architecture decisions or ambiguous " +
        "requirements. ALWAYS review the returned steps/finalText before trusting file changes were correct.",
      inputSchema: {
        task: z.string().describe("Self-contained task description -- the worker has no memory of your conversation."),
        workspace_root: z.string().describe("Absolute path the worker's file tools are scoped to. Must be listed in allowedRoots in the server config."),
        model: z.string().optional().describe("Override the default model."),
        think: z.boolean().optional().describe("Enable thinking -- only for genuine single-hop logic, not bulk/mechanical work."),
        max_steps: z.number().optional().describe("Cap on tool-calling loop iterations (default 8)."),
      },
    },
    async ({ task, workspace_root, model, think, max_steps }) => {
      const result = await runDelegatedTask(config, {
        task,
        workspaceRoot: workspace_root,
        model,
        think,
        maxSteps: max_steps,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { finalText: result.finalText, modelUsed: result.modelUsed, steps: result.steps },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.registerTool(
    "list_worker_config",
    { description: "Show the current local-worker-mcp configuration (model, allowed roots, etc.)." },
    async () => ({ content: [{ type: "text", text: JSON.stringify(config, null, 2) }] })
  );

  return server;
}

const app = express();
app.use(express.json());

// ---- MCP endpoint (stateful streamable-http, one transport per session) ----
const transports = new Map<string, StreamableHTTPServerTransport>();

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport = sessionId ? transports.get(sessionId) : undefined;

  if (!transport) {
    const server = buildMcpServer();
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => { transports.set(id, transport!); },
    });
    transport.onclose = () => {
      if (transport!.sessionId) transports.delete(transport!.sessionId);
    };
    await server.connect(transport);
  }
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) {
    res.status(400).send("No active session");
    return;
  }
  await transport.handleRequest(req, res);
});

// ---- tiny config dashboard (no build step, plain HTML + fetch) ----
app.get("/", (_req, res) => {
  res.type("html").send(DASHBOARD_HTML);
});
app.get("/api/config", (_req, res) => res.json(config));
app.post("/api/config", (req, res) => {
  const next: WorkerConfig = { ...config, ...req.body };
  saveConfig(next);
  config = next;
  res.json({ ok: true, config });
});

const DASHBOARD_HTML = `<!doctype html>
<title>local-worker-mcp</title>
<style>
  body { font: 14px -apple-system, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 16px; }
  label { display: block; margin: 14px 0 4px; font-weight: 600; }
  input, textarea { width: 100%; box-sizing: border-box; padding: 6px 8px; font: 13px monospace; }
  button { margin-top: 20px; padding: 8px 16px; }
  .hint { color: #666; font-size: 12px; }
</style>
<h1>local-worker-mcp</h1>
<p class="hint">Config lives in <code>~/.local-worker-mcp/config.json</code>. Changes here are saved straight there.</p>
<form id="f">
  <label>Ollama host</label><input name="ollamaHost">
  <label>Default model</label><input name="defaultModel">
  <label>Default thinking</label>
  <select name="defaultThink"><option value="false">false</option><option value="true">true</option></select>
  <label>Context length</label><input name="defaultCtx" type="number">
  <label>Max tokens per response</label><input name="defaultMaxTokens" type="number">
  <label>Allowed roots (one per line, absolute paths)</label>
  <textarea name="allowedRoots" rows="4"></textarea>
  <label>Web search enabled</label>
  <select name="webSearchEnabled"><option value="true">true</option><option value="false">false</option></select>
  <button type="submit">Save</button>
</form>
<p id="status"></p>
<script>
  const f = document.getElementById('f');
  fetch('/api/config').then(r => r.json()).then(cfg => {
    for (const [k, v] of Object.entries(cfg)) {
      const el = f.elements[k];
      if (!el) continue;
      if (k === 'allowedRoots') el.value = v.join('\\n');
      else if (el.tagName === 'SELECT') el.value = String(v);
      else el.value = v;
    }
  });
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(f);
    const body = {
      ollamaHost: fd.get('ollamaHost'),
      defaultModel: fd.get('defaultModel'),
      defaultThink: fd.get('defaultThink') === 'true',
      defaultCtx: Number(fd.get('defaultCtx')),
      defaultMaxTokens: Number(fd.get('defaultMaxTokens')),
      allowedRoots: String(fd.get('allowedRoots')).split('\\n').map(s => s.trim()).filter(Boolean),
      webSearchEnabled: fd.get('webSearchEnabled') === 'true',
    };
    const r = await fetch('/api/config', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
    document.getElementById('status').textContent = r.ok ? 'Saved.' : 'Error saving.';
  });
</script>
`;

app.listen(config.port, () => {
  console.log(`local-worker-mcp listening on http://localhost:${config.port} (MCP endpoint: /mcp, dashboard: /)`);
});
