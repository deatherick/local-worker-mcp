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
        "(read/list/write files under workspace_root, search the web, get current datetime, and verify its own " +
        "work with run_checks -- build/typecheck/test, capped per task) until done. Use for mechanical/bulk work " +
        "you can verify afterward -- not for architecture decisions or ambiguous requirements. ALWAYS review the " +
        "returned steps/finalText before trusting file changes were correct, even though the worker now " +
        "self-checks its own build/tests -- that catches compile errors, not design mistakes.",
      inputSchema: {
        task: z.string().describe("Self-contained task description -- the worker has no memory of your conversation."),
        workspace_root: z.string().describe("Absolute path the worker's file tools are scoped to. Must be listed in allowedRoots in the server config."),
        model: z.string().optional().describe("Override the default model."),
        think: z.boolean().optional().describe("Enable thinking -- only for genuine single-hop logic, not bulk/mechanical work."),
        max_steps: z.number().optional().describe("Cap on tool-calling loop iterations (default 8)."),
      },
    },
    async ({ task, workspace_root, model, think, max_steps }, extra) => {
      const startedAt = new Date().toISOString();
      // Forward progress to the calling MCP client (only if it asked for it
      // by sending a progressToken) so it doesn't think this call is dead
      // during a long tool-calling loop -- found in practice: a real ~6-step
      // delegation took ~350s, past Claude Code's default 300s idle-tool
      // timeout, and got aborted client-side even though the server was
      // actively working the whole time.
      const progressToken = extra._meta?.progressToken;
      const onProgress = progressToken === undefined ? undefined : (message: string) => {
        extra.sendNotification({
          method: "notifications/progress",
          params: { progressToken, progress: 0, message },
        }).catch(() => {
          /* best-effort -- a dropped progress notification shouldn't fail the task */
        });
      };

      try {
        const result = await runDelegatedTask(config, {
          task,
          workspaceRoot: workspace_root,
          model,
          think,
          maxSteps: max_steps,
          onProgress,
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

// ---- Config API ----
app.get("/api/config", (_req, res) => res.json(config));
app.post("/api/config", (req, res) => {
  const next: WorkerConfig = { ...config, ...req.body };
  saveConfig(next);
  config = next;
  res.json({ ok: true, config });
});

// ---- Usage API ----
app.get("/api/usage", (_req, res) => {
  res.json(summarizeUsage(readUsage()));
});

// ---- Single-page dashboard shell ----
app.get("/", (_req, res) => {
  res.type("html").send(APP_HTML);
});
app.get("/usage", (_req, res) => {
  // Alias: serve the same page but pre-select the Usage tab for backward compat.
  res.type("html").send(APP_HTML);
});

// ---------------------------------------------------------------------------
// Shared HTML shell (served at / and /usage)
// ---------------------------------------------------------------------------

const APP_HTML = `<!doctype html>
<title>local-worker-mcp</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.5.1/chart.umd.min.js"></script>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px -apple-system, sans-serif; max-width: 980px; margin: 0; padding: 0; background: #fff; color: #1a1a1a; }

  /* Tab bar */
  .tab-bar { display: flex; border-bottom: 2px solid #ddd; position: sticky; top: 0; background: #fff; z-index: 10; }
  @media (prefers-color-scheme: dark) { body { background: #14151a; color: #e8e8e8; } .tab-bar { border-bottom-color: #333; } .panel { background: #14151a; } label, th { color: #ccc !important; } }
  .tab-btn { padding: 12px 24px; font-size: 14px; font-weight: 600; cursor: pointer; border: none; background: transparent; color: #888; border-bottom: 3px solid transparent; margin-bottom: -2px; transition: all .15s; }
  .tab-btn:hover { color: #444; }
  @media (prefers-color-scheme: dark) { .tab-btn:hover { color: #ccc; } }
  .tab-btn.active { color: #6a55d6; border-bottom-color: #6a55d6; }
  @media (prefers-color-scheme: dark) { .tab-btn.active { color: #8b7cf7; border-bottom-color: #8b7cf7; } }

  /* Panels */
  .panel { padding: 24px 16px; max-width: 980px; margin: 0 auto; display: none; }
  .panel.visible { display: block; }

  /* Config form */
  label { display: block; margin: 14px 0 4px; font-weight: 600; color: #333; }
  @media (prefers-color-scheme: dark) { label { color: #ccc; } }
  input, textarea, select { width: 100%; box-sizing: border-box; padding: 6px 8px; font: 13px monospace; background: #f9f9f9; border: 1px solid #ddd; border-radius: 4px; }
  @media (prefers-color-scheme: dark) { input, textarea, select { background: #22232b; border-color: #444; color: #e8e8e8; } }
  button { margin-top: 20px; padding: 8px 16px; background: #6a55d6; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; }
  button:hover { opacity: .9; }
  .hint { color: #888; font-size: 12px; margin-top: 4px; }
  p#status { margin-top: 16px; color: #6a55d6; font-weight: 600; min-height: 1em; }

  /* Usage tab */
  h1 { margin: 0 0 8px; font-size: 22px; }
  .sub-hint { color: #888; font-size: 13px; margin-bottom: 16px; }
  h2 { margin-top: 36px; font-size: 15px; text-transform: uppercase; letter-spacing: .03em; color: #888; }

  /* Stat cards */
  .stats { display: flex; flex-wrap: wrap; gap: 16px; margin: 16px 0; }
  .stat { background: #f4f4f4; border-radius: 8px; padding: 12px 18px; min-width: 130px; }
  @media (prefers-color-scheme: dark) { .stat { background: #22232b !important; } }
  .stat .n { font-size: 22px; font-weight: 700; display: block; }
  .stat .l { font-size: 11px; color: #888; text-transform: uppercase; }
  .stat.highlight { background: #6a55d61a; border: 1px solid #6a55d6; }

  /* Charts */
  .charts { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-top: 12px; }
  .chart-box { height: 260px; background: #fafafa; border-radius: 8px; padding: 12px; }
  @media (prefers-color-scheme: dark) { .chart-box { background: #1c1d24 !important; } }
  .chart-box.wide { grid-column: 1 / -1; }

  /* Live indicator */
  .live-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #1f9d63; margin-right: 4px; vertical-align: middle; animation: pulse 1.2s infinite; }
  @keyframes pulse { 0% { opacity: 1; } 50% { opacity: .25; } 100% { opacity: 1; } }

  /* Project filter */
  .filter-bar { margin: 16px 0; display: flex; align-items: center; gap: 8px; }
  .filter-bar label { font-size: 13px; color: #888; margin: 0; }
  .filter-bar select { width: auto; min-width: 200px; padding: 4px 8px; }

  /* Tables */
  table { border-collapse: collapse; width: 100%; font-size: 12px; margin-top: 8px; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #eee; white-space: nowrap; }
  @media (prefers-color-scheme: dark) { th, td { border-color: #333 !important; } th { color: #aaa !important; } }
  .fail { color: #c0392b; }

  @media (max-width: 700px) { .charts { grid-template-columns: 1fr; } }
</style>

<h1>local-worker-mcp</h1>

<div class="tab-bar" id="tabBar">
  <button class="tab-btn active" data-tab="config">Config</button>
  <button class="tab-btn" data-tab="usage">Usage</button>
</div>

<!-- Config panel -->
<div class="panel visible" id="panel-config">
  <p class="sub-hint">Config lives in <code>~/.local-worker-mcp/config.json</code>. Changes here are saved straight there.</p>
  <form id="configForm">
    <label>Ollama host</label><input name="ollamaHost" value="">
    <label>Default model</label><input name="defaultModel" value="">
    <label>Default thinking</label>
    <select name="defaultThink"><option value="false">false</option><option value="true">true</option></select>
    <label>Context length</label><input name="defaultCtx" type="number" value="">
    <label>Max tokens per response</label><input name="defaultMaxTokens" type="number" value="">
    <label>Allowed roots (one per line, absolute paths -- exact folders)</label>
    <textarea name="allowedRoots" rows="3"></textarea>
    <label>Trusted parents (one per line -- any subfolder under these is auto-allowed, e.g. ~/code so every project there just works without listing each one)</label>
    <textarea name="trustedParents" rows="3"></textarea>
    <label>Web search enabled</label>
    <select name="webSearchEnabled"><option value="true">true</option><option value="false">false</option></select>
    <button type="submit">Save</button>
  </form>
  <p id="configStatus"></p>
</div>

<!-- Usage panel -->
<div class="panel" id="panel-usage">
  <h2>Usage Dashboard <span class="live-dot" id="liveDot" style="display:none;"></span></h2>

  <div class="filter-bar">
    <label for="projectFilter">Project:</label>
    <select id="projectFilter"><option value="__all__">All projects</option></select>
  </div>

  <div class="stats" id="statCards"></div>
  <p class="hint">*Prompt + output tokens processed by the local model instead of a cloud one -- a proxy for work offloaded.</p>

  <div class="charts">
    <div class="chart-box"><canvas id="chartByProject"></canvas></div>
    <div class="chart-box"><canvas id="chartByModel"></canvas></div>
    <div class="chart-box wide"><canvas id="chartByDay"></canvas></div>
  </div>

  <h2>By session</h2>
  <table><thead><tr><th>Session</th><th>Calls</th><th>Output tokens</th><th>Projects</th></tr></thead>
    <tbody id="sessionTable"></tbody>
  </table>

  <h2>Recent calls</h2>
  <table><thead><tr><th>Time</th><th>Project</th><th>Model</th><th>Think</th><th>Steps</th><th>Tokens</th><th>Duration</th><th>Status</th></tr></thead>
    <tbody id="recentTable"></tbody>
  </table>
</div>

<script>
(function() {
  /* ---- Tab switching ---- */
  var tabBar = document.getElementById('tabBar');
  var panels = { config: document.getElementById('panel-config'), usage: document.getElementById('panel-usage') };

  function showTab(name) {
    for (var n in panels) { panels[n].classList.remove('visible'); }
    tabBar.querySelectorAll('.tab-btn').forEach(function(btn) {
      btn.classList.toggle('active', btn.getAttribute('data-tab') === name);
    });
    panels[name].classList.add('visible');
  }
  tabBar.addEventListener('click', function(e) {
    var btn = e.target.closest('.tab-btn');
    if (!btn) return;
    showTab(btn.getAttribute('data-tab'));
  });

  /* Determine which tab to start on based on URL */
  (function() {
    if (location.pathname === '/usage') showTab('usage');
    else showTab('config');
  })();

  /* ---- Config form loading/saving (unchanged semantics) ---- */
  var configForm = document.getElementById('configForm');
  var configStatus = document.getElementById('configStatus');

  fetch('/api/config').then(function(r) { return r.json(); }).then(function(cfg) {
    for (var key in cfg) {
      var el = configForm.elements[key];
      if (!el) continue;
      if (key === 'allowedRoots' || key === 'trustedParents') el.value = cfg[key].join('\\\\n');
      else if (el.tagName === 'SELECT') el.value = String(cfg[key]);
      else el.value = cfg[key] == null ? '' : String(cfg[key]);
    }
  });

  configForm.addEventListener('submit', function(e) {
    e.preventDefault();
    var fd = new FormData(configForm);
    var body = {
      ollamaHost: fd.get('ollamaHost'),
      defaultModel: fd.get('defaultModel'),
      defaultThink: fd.get('defaultThink') === 'true',
      defaultCtx: Number(fd.get('defaultCtx')),
      defaultMaxTokens: Number(fd.get('defaultMaxTokens')),
      allowedRoots: String(fd.get('allowedRoots')).split('\\\\n').map(function(s) { return s.trim(); }).filter(Boolean),
      trustedParents: String(fd.get('trustedParents')).split('\\\\n').map(function(s) { return s.trim(); }).filter(Boolean),
      webSearchEnabled: fd.get('webSearchEnabled') === 'true',
    };
    fetch('/api/config', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) })
      .then(function(r) { return r.json(); }).then(function() {
        configStatus.textContent = 'Saved.';
        setTimeout(function(){ configStatus.textContent = ''; }, 2000);
      });
  });

  /* ---- Usage data & live charts ---- */
  var PALETTE = ['#6a55d6', '#2563c9', '#1f9d63', '#b5790a', '#cc3340', '#0891b2', '#c026d3'];

  var chartByProject, chartByModel, chartByDay;
  var liveDot = document.getElementById('liveDot');
  var projectFilterSelect = document.getElementById('projectFilter');

  /* Simple project label helper */
  function projectLabel(workspaceRoot) {
    var lastSlash = workspaceRoot.lastIndexOf('/');
    return lastSlash >= 0 ? workspaceRoot.slice(lastSlash + 1) : workspaceRoot;
  }

  /* Build chart data from raw records (used for client-side re-aggregation) */
  function buildAgg(records) {
    var byProjectMap = new Map();
    var byDayMap = new Map();
    var byModelMap = new Map();
    var totalCalls = records.length;
    var totalSuccesses = 0, totalFailures = 0;
    var totalOutputTokens = 0, totalPromptTokens = 0, totalDurationMs = 0;

    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      var project = projectLabel(r.workspaceRoot);
      var day = r.timestamp.slice(0, 10);
      if (r.success) totalSuccesses++; else totalFailures++;
      totalOutputTokens += r.outputTokens;
      totalPromptTokens += r.promptTokens;
      totalDurationMs += r.totalDurationMs;

      if (!byProjectMap.has(project)) byProjectMap.set(project, { calls: 0, outputTokens: 0, promptTokens: 0, durationMs: 0 });
      var p = byProjectMap.get(project); p.calls++; p.outputTokens += r.outputTokens; p.promptTokens += r.promptTokens; p.durationMs += r.totalDurationMs;

      if (!byDayMap.has(day)) byDayMap.set(day, { calls: 0, outputTokens: 0, promptTokens: 0 });
      var d = byDayMap.get(day); d.calls++; d.outputTokens += r.outputTokens; d.promptTokens += r.promptTokens;

      if (!byModelMap.has(r.model)) byModelMap.set(r.model, { calls: 0, outputTokens: 0 });
      var m = byModelMap.get(r.model); m.calls++; m.outputTokens += r.outputTokens;
    }

    return {
      totalCalls: totalCalls,
      totalSuccesses: totalSuccesses,
      totalFailures: totalFailures,
      totalOutputTokens: totalOutputTokens,
      totalPromptTokens: totalPromptTokens,
      totalTokensOffCloud: totalOutputTokens + totalPromptTokens,
      totalDurationMs: totalDurationMs,
      byProject: [...byProjectMap.entries()].map(function(e){ var pk = e[0], v = e[1]; return { project: pk, calls: v.calls, outputTokens: v.outputTokens, promptTokens: v.promptTokens, durationMs: v.durationMs }; }).sort(function(a,b){ return b.calls - a.calls; }),
      byDay: [...byDayMap.entries()].map(function(e){ var dk = e[0], v = e[1]; return { day: dk, calls: v.calls, outputTokens: v.outputTokens, promptTokens: v.promptTokens }; }).sort(function(a,b){ return a.day.localeCompare(b.day); }),
      byModel: [...byModelMap.entries()].map(function(e){ var mk = e[0], v = e[1]; return { model: mk, calls: v.calls, outputTokens: v.outputTokens }; }).sort(function(a,b){ return b.calls - a.calls; }),
    };
  }

  /* Render stat cards */
  function renderStats(stats) {
    document.getElementById('statCards').innerHTML =
      '<div class="stat"><span class="n">' + stats.totalCalls + '</span><span class="l">Total calls</span></div>' +
      '<div class="stat"><span class="n">' + stats.totalSuccesses + '</span><span class="l">Succeeded</span></div>' +
      '<div class="stat"><span class="n' + (stats.totalFailures > 0 ? ' fail' : '') + '">' + stats.totalFailures + '</span><span class="l">Failed</span></div>' +
      '<div class="stat"><span class="n">' + (stats.totalDurationMs / 1000).toFixed(1) + 's</span><span class="l">Total local compute time</span></div>' +
      '<div class="stat highlight"><span class="n">' + stats.totalTokensOffCloud.toLocaleString() + '</span><span class="l">Tokens kept off cloud*</span></div>';
  }

  /* Update chart instances in-place */
  function updateCharts(filtered) {
    var bpData = filtered.byProject;
    var pLabels = bpData.map(function(p){ return p.project; });
    var cData = bpData.map(function(p){ return p.calls; });
    var tData = bpData.map(function(p){ return p.outputTokens; });

    chartByProject.data.labels = pLabels;
    chartByProject.data.datasets[0].data = cData;
    chartByProject.data.datasets[1].data = tData;
    chartByProject.update('none');

    var mData = filtered.byModel;
    chartByModel.data.labels = mData.map(function(m){ return m.model; });
    chartByModel.data.datasets[0].data = mData.map(function(m){ return m.calls; });
    chartByModel.update('none');

    var dData = filtered.byDay;
    chartByDay.data.labels = dData.map(function(d){ return d.day; });
    chartByDay.data.datasets[0].data = dData.map(function(d){ return d.calls; });
    chartByDay.update('none');
  }

  /* Render tables from raw records (the filtered set, not the full dataset) */
  function renderTables(rawRecords, filtered) {
    var bySessionMap = new Map();
    for (var i = 0; i < rawRecords.length; i++) {
      var r = rawRecords[i];
      var sid = r.sessionId || 'unknown';
      if (!bySessionMap.has(sid)) bySessionMap.set(sid, { sessionId: sid, calls: 0, outputTokens: 0, projects: new Set() });
      var s = bySessionMap.get(sid);
      s.calls++; s.outputTokens += r.outputTokens; s.projects.add(projectLabel(r.workspaceRoot));
    }

    var sessionRows = [...bySessionMap.entries()]
      .map(function(e){ var s = e[1]; return '<tr><td>' + s.sessionId.slice(0,8) + '…</td><td>' + s.calls + '</td><td>' + s.outputTokens.toLocaleString() + '</td><td>' + [...s.projects].join(', ') + '</td></tr>'; })
      .join('') || '<tr><td colspan="4">No usage yet.</td></tr>';
    document.getElementById('sessionTable').innerHTML = sessionRows;

    var recent = rawRecords.slice(-20).reverse();
    var recentRows = recent.map(function(r){
      return '<tr>' +
        '<td>' + new Date(r.timestamp).toLocaleString() + '</td>' +
        '<td>' + projectLabel(r.workspaceRoot) + '</td>' +
        '<td>' + r.model + '</td>' +
        '<td>' + r.think + '</td>' +
        '<td>' + r.toolCallSteps + '</td>' +
        '<td>' + r.outputTokens + '</td>' +
        '<td>' + (r.totalDurationMs / 1000).toFixed(1) + 's</td>' +
        '<td class="' + (r.success ? '' : 'fail') + '">' + (r.success ? 'ok' : 'error: ' + (r.errorMessage || '')) + '</td></tr>';
    }).join('') || '<tr><td colspan="8">No usage yet.</td></tr>';
    document.getElementById('recentTable').innerHTML = recentRows;
  }

  /* Build project filter dropdown options */
  function buildProjectFilter(allRecords) {
    var projects = new Set();
    for (var i = 0; i < allRecords.length; i++) projects.add(projectLabel(allRecords[i].workspaceRoot));
    var opts = '<option value="__all__">All projects</option>';
    var sorted = Array.from(projects).sort();
    for (var j = 0; j < sorted.length; j++) {
      opts += '<option value="' + sorted[j] + '">' + sorted[j] + '</option>';
    }
    projectFilterSelect.innerHTML = opts;
  }

  /* Apply the selected project filter and re-render everything */
  function applyUpdate(records) {
    var projectName = projectFilterSelect.value;
    if (projectName && projectName !== '__all__') {
      records = records.filter(function(r){ return projectLabel(r.workspaceRoot) === projectName; });
    }
    buildProjectFilter(records); /* rebuild to only show current projects */
    var agg = buildAgg(records);
    renderStats(agg);

    if (!agg.totalCalls) {
      document.getElementById('sessionTable').innerHTML = '<tr><td colspan="4">No usage yet.</td></tr>';
      document.getElementById('recentTable').innerHTML = '<tr><td colspan="8">No usage yet.</td></tr>';
      chartByProject.data.labels = []; chartByProject.data.datasets[0].data = []; chartByProject.data.datasets[1].data = [];
      chartByModel.data.labels = []; chartByModel.data.datasets[0].data = [];
      chartByDay.data.labels = []; chartByDay.data.datasets[0].data = [];
      chartByProject.update('none');
      chartByModel.update('none');
      chartByDay.update('none');
      return;
    }

    updateCharts(agg);
    renderTables(records, agg);
  }

  /* Initial load */
  var _rawRecords = []; /* store for table rendering */
  fetch('/api/usage').then(function(r){ return r.json(); }).then(function(data) {
    _rawRecords = data.records || [];
    buildProjectFilter(_rawRecords);
    applyUpdate(_rawRecords);

    projectFilterSelect.addEventListener('change', function() { applyUpdate(_rawRecords); });

    /* Live poll every 5 seconds */
    (function poll() {
      fetch('/api/usage').then(function(r){ return r.json(); }).then(function(data) {
        _rawRecords = data.records || [];
        var currentVal = projectFilterSelect.value;
        applyUpdate(_rawRecords); /* re-apply the currently-selected filter */

        if (_rawRecords.length > 0 || true) {
          liveDot.style.display = 'inline-block';
        }
      }).catch(function(){ /* ignore poll errors */ });

      setTimeout(poll, 5000);
    })();

    liveDot.style.display = 'inline-block';
  });
})();
</script>
`;

app.listen(config.port, () => {
  console.log(`local-worker-mcp listening on http://localhost:${config.port} (MCP endpoint: /mcp, dashboard: /)`);
});
