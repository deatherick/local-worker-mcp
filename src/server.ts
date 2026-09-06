import express from "express";
import { randomUUID } from "crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig, saveConfig, WorkerConfig } from "./config.js";
import { runDelegatedTask } from "./ollama.js";
import { logUsage, readUsage, summarizeUsage } from "./usage.js";

let config = loadConfig();

function buildMcpServer(getSessionId: () => string | undefined): McpServer {
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
      const startedAt = new Date().toISOString();
      try {
        const result = await runDelegatedTask(config, {
          task,
          workspaceRoot: workspace_root,
          model,
          think,
          maxSteps: max_steps,
        });
        logUsage({
          timestamp: startedAt,
          sessionId: getSessionId(),
          workspaceRoot: workspace_root,
          model: result.modelUsed,
          think: think ?? config.defaultThink,
          success: true,
          toolCallSteps: result.steps.length,
          totalDurationMs: result.metrics.totalDurationMs,
          loadDurationMs: result.metrics.loadDurationMs,
          promptTokens: result.metrics.promptTokens,
          outputTokens: result.metrics.outputTokens,
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
      } catch (e: any) {
        logUsage({
          timestamp: startedAt,
          sessionId: getSessionId(),
          workspaceRoot: workspace_root,
          model: model || config.defaultModel,
          think: think ?? config.defaultThink,
          success: false,
          errorMessage: e.message || String(e),
          toolCallSteps: 0,
          totalDurationMs: 0,
          loadDurationMs: 0,
          promptTokens: 0,
          outputTokens: 0,
        });
        throw e;
      }
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
    const server = buildMcpServer(() => transport?.sessionId);
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

app.get("/usage", (_req, res) => {
  res.type("html").send(USAGE_HTML);
});
app.get("/api/usage", (_req, res) => {
  res.json(summarizeUsage(readUsage()));
});

const DASHBOARD_HTML = `<!doctype html>
<title>local-worker-mcp</title>
<style>
  body { font: 14px -apple-system, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 16px; }
  nav a { margin-right: 16px; }
  label { display: block; margin: 14px 0 4px; font-weight: 600; }
  input, textarea { width: 100%; box-sizing: border-box; padding: 6px 8px; font: 13px monospace; }
  button { margin-top: 20px; padding: 8px 16px; }
  .hint { color: #666; font-size: 12px; }
</style>
<h1>local-worker-mcp</h1>
<nav><a href="/">Config</a><a href="/usage">Usage</a></nav>
<p class="hint">Config lives in <code>~/.local-worker-mcp/config.json</code>. Changes here are saved straight there.</p>
<form id="f">
  <label>Ollama host</label><input name="ollamaHost">
  <label>Default model</label><input name="defaultModel">
  <label>Default thinking</label>
  <select name="defaultThink"><option value="false">false</option><option value="true">true</option></select>
  <label>Context length</label><input name="defaultCtx" type="number">
  <label>Max tokens per response</label><input name="defaultMaxTokens" type="number">
  <label>Allowed roots (one per line, absolute paths -- exact folders)</label>
  <textarea name="allowedRoots" rows="3"></textarea>
  <label>Trusted parents (one per line -- any subfolder under these is auto-allowed, e.g. ~/code so every project there just works without listing each one)</label>
  <textarea name="trustedParents" rows="3"></textarea>
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
      if (k === 'allowedRoots' || k === 'trustedParents') el.value = v.join('\\n');
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
      trustedParents: String(fd.get('trustedParents')).split('\\n').map(s => s.trim()).filter(Boolean),
      webSearchEnabled: fd.get('webSearchEnabled') === 'true',
    };
    const r = await fetch('/api/config', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
    document.getElementById('status').textContent = r.ok ? 'Saved.' : 'Error saving.';
  });
</script>
`;

const USAGE_HTML = `<!doctype html>
<title>local-worker-mcp -- usage</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.5.1/chart.umd.min.js"></script>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px -apple-system, sans-serif; max-width: 980px; margin: 40px auto; padding: 0 16px; background: #fff; color: #1a1a1a; }
  @media (prefers-color-scheme: dark) { body { background: #14151a; color: #e8e8e8; } .stat { background: #22232b !important; } th, td { border-color: #333 !important; } .bar-track { background: #333 !important; } }
  nav a { margin-right: 16px; }
  h2 { margin-top: 36px; font-size: 15px; text-transform: uppercase; letter-spacing: .03em; color: #888; }
  .stats { display: flex; flex-wrap: wrap; gap: 16px; margin: 16px 0; }
  .stat { background: #f4f4f4; border-radius: 8px; padding: 12px 18px; min-width: 130px; }
  .stat .n { font-size: 22px; font-weight: 700; display: block; }
  .stat .l { font-size: 11px; color: #888; text-transform: uppercase; }
  .stat.highlight { background: #6a55d61a; border: 1px solid #6a55d6; }
  .charts { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-top: 12px; }
  .chart-box { height: 260px; }
  .chart-box.wide { grid-column: 1 / -1; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; margin-top: 8px; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #eee; white-space: nowrap; }
  th { color: #888; font-weight: 600; }
  .fail { color: #c0392b; }
  .hint { color: #888; font-size: 11px; }
</style>
<h1>local-worker-mcp</h1>
<nav><a href="/">Config</a><a href="/usage">Usage</a></nav>
<div id="root">Loading…</div>
<script>
const PALETTE = ['#6a55d6', '#2563c9', '#1f9d63', '#b5790a', '#cc3340', '#0891b2', '#c026d3'];

fetch('/api/usage').then(r => r.json()).then(s => {
  document.getElementById('root').innerHTML = \`
    <div class="stats">
      <div class="stat"><span class="n">\${s.totalCalls}</span><span class="l">Total calls</span></div>
      <div class="stat"><span class="n">\${s.totalSuccesses}</span><span class="l">Succeeded</span></div>
      <div class="stat"><span class="n \${s.totalFailures > 0 ? 'fail' : ''}">\${s.totalFailures}</span><span class="l">Failed</span></div>
      <div class="stat"><span class="n">\${(s.totalDurationMs / 1000).toFixed(1)}s</span><span class="l">Total local compute time</span></div>
      <div class="stat highlight"><span class="n">\${s.totalTokensOffCloud.toLocaleString()}</span><span class="l">Tokens kept off cloud AI*</span></div>
    </div>
    <p class="hint">*Prompt + output tokens processed by the local model instead of a cloud one -- a proxy for work offloaded, not a precise dollar-for-dollar equivalent (a cloud model wouldn't necessarily use the exact same token count for the same task).</p>

    <div class="charts">
      <div class="chart-box"><canvas id="byProject"></canvas></div>
      <div class="chart-box"><canvas id="byModel"></canvas></div>
      <div class="chart-box wide"><canvas id="byDay"></canvas></div>
    </div>

    <h2>By session</h2>
    <table>
      <tr><th>Session</th><th>Calls</th><th>Output tokens</th><th>Projects</th></tr>
      \${s.bySession.map(sess => \`<tr>
        <td>\${sess.sessionId.slice(0, 8)}…</td>
        <td>\${sess.calls}</td>
        <td>\${sess.outputTokens.toLocaleString()}</td>
        <td>\${sess.projects.join(', ')}</td>
      </tr>\`).join('') || '<tr><td colspan="4">No usage yet.</td></tr>'}
    </table>

    <h2>Recent calls</h2>
    <table>
      <tr><th>Time</th><th>Project</th><th>Model</th><th>Think</th><th>Steps</th><th>Tokens</th><th>Duration</th><th>Status</th></tr>
      \${s.recent.map(r => \`<tr>
        <td>\${new Date(r.timestamp).toLocaleString()}</td>
        <td>\${r.workspaceRoot.split('/').pop()}</td>
        <td>\${r.model}</td>
        <td>\${r.think}</td>
        <td>\${r.toolCallSteps}</td>
        <td>\${r.outputTokens}</td>
        <td>\${(r.totalDurationMs / 1000).toFixed(1)}s</td>
        <td class="\${r.success ? '' : 'fail'}">\${r.success ? 'ok' : 'error: ' + (r.errorMessage || '')}</td>
      </tr>\`).join('') || '<tr><td colspan="8">No usage yet.</td></tr>'}
    </table>
  \`;

  if (!s.totalCalls) return;

  new Chart(document.getElementById('byProject'), {
    type: 'bar',
    data: {
      labels: s.byProject.map(p => p.project),
      datasets: [
        { label: 'Calls', data: s.byProject.map(p => p.calls), backgroundColor: PALETTE[0] },
        { label: 'Output tokens', data: s.byProject.map(p => p.outputTokens), backgroundColor: PALETTE[1], yAxisID: 'y1' },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { title: { display: true, text: 'Calls & tokens by project' } },
      scales: { y: { beginAtZero: true }, y1: { beginAtZero: true, position: 'right', grid: { drawOnChartArea: false } } },
    },
  });

  new Chart(document.getElementById('byModel'), {
    type: 'doughnut',
    data: {
      labels: s.byModel.map(m => m.model),
      datasets: [{ data: s.byModel.map(m => m.calls), backgroundColor: PALETTE }],
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { title: { display: true, text: 'Calls by model' } } },
  });

  new Chart(document.getElementById('byDay'), {
    type: 'line',
    data: {
      labels: s.byDay.map(d => d.day),
      datasets: [
        { label: 'Calls', data: s.byDay.map(d => d.calls), borderColor: PALETTE[0], backgroundColor: PALETTE[0] + '33', fill: true, tension: 0.2 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { title: { display: true, text: 'Calls over time' } },
      scales: { y: { beginAtZero: true } },
    },
  });
});
</script>
`;

app.listen(config.port, () => {
  console.log(`local-worker-mcp listening on http://localhost:${config.port} (MCP endpoint: /mcp, dashboard: /)`);
});
