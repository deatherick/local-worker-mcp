import express from "express";
import { randomUUID } from "crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig, saveConfig, WorkerConfig } from "./config.js";
import { runDelegatedTask } from "./ollama.js";
import { logUsage, readUsage, summarizeUsage, projectLabel } from "./usage.js";
import { readCloudUsage, summarizeCloudUsage } from "./cloudUsage.js";
import { getModelInfo } from "./modelInfo.js";

let config = loadConfig();

// ---------------------------------------------------------------------------
// Active-task registry (in-memory only; live state resets on restart)
// ---------------------------------------------------------------------------
interface ActiveStep {
  timestamp: string;
  message: string;
}

interface ActiveTask {
  id: string;
  workspaceRoot: string;
  model: string;
  think: boolean;
  startedAt: string;
  lastUpdateAt: number; /* Date.now() at last progress push */
  steps: ActiveStep[];
}

const activeTasks = new Map<string, ActiveTask>();

// A single step's raw args/result can hold a whole file's contents (write_file,
// read_file) or run_checks output -- across a multi-step task these add up fast
// and can blow past the calling client's per-tool-result size limit (seen in
// practice: a 13-step task returned a 144KB response). The foreman doesn't need
// every byte back to review the work -- it can (and should) read the actual
// files afterward -- so previews here, not full content.
const STEP_PREVIEW_CHARS = 300;
function truncatePreview(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}... [truncated, ${value.length} chars total]` : value;
}
function previewSteps(steps: { tool: string; args: any; result: string }[]) {
  return steps.map((s) => ({
    tool: s.tool,
    args: truncatePreview(JSON.stringify(s.args), STEP_PREVIEW_CHARS),
    result: truncatePreview(s.result, STEP_PREVIEW_CHARS),
  }));
}

// ---------------------------------------------------------------------------
// MCP server builder
// ---------------------------------------------------------------------------

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

      // Register this call as an active task
      const taskId = randomUUID();
      const modelUsed = model || config.defaultModel;
      activeTasks.set(taskId, {
        id: taskId,
        workspaceRoot: workspace_root,
        model: modelUsed,
        think: think ?? false,
        startedAt,
        lastUpdateAt: Date.now(),
        steps: [],
      });

      // Forward progress to the calling MCP client (only if it asked for it
      // by sending a progressToken) so it doesn't think this call is dead
      // during a long tool-calling loop -- found in practice: a real ~6-step
      // delegation took ~350s, past Claude Code's default 300s idle-tool
      // timeout, and got aborted client-side even though the server was
      // actively working the whole time.
      const progressToken = extra._meta?.progressToken;
      const onProgress = progressToken === undefined ? undefined : (message: string) => {
        /* Also record in the active-task registry so /api/active has data */
        const task = activeTasks.get(taskId);
        if (task) {
          task.lastUpdateAt = Date.now();
          task.steps.push({ timestamp: new Date().toISOString(), message });
        }

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

        /* Clean up active registry */
        activeTasks.delete(taskId);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { finalText: result.finalText, modelUsed: result.modelUsed, steps: previewSteps(result.steps) },
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

        /* Clean up active registry */
        activeTasks.delete(taskId);

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

// ---- Cloud (Claude Code) usage API -- reads local session transcripts, no
// active-session cooperation needed; see cloudUsage.ts for how/why. ----
app.get("/api/cloud-usage", (_req, res) => {
  res.json(summarizeCloudUsage(readCloudUsage()));
});

// ---- Model info API -- metadata only (no model load), always reflects
// whatever is currently configured as defaultModel. ----
app.get("/api/model-info", async (_req, res) => {
  try {
    res.json(await getModelInfo(config));
  } catch (e: any) {
    res.status(502).json({ error: e.message || String(e) });
  }
});

// ---- Active (live tasks) API ----
app.get("/api/active", (_req, res) => {
  const now = Date.now();
  const result: Array<{
    id: string;
    workspaceRoot: string;
    project: string;
    model: string;
    think: boolean;
    startedAt: string;
    elapsedMs: number;
    steps: ActiveStep[];
  }> = [];

  for (const task of activeTasks.values()) {
    result.push({
      id: task.id,
      workspaceRoot: task.workspaceRoot,
      project: projectLabel(task.workspaceRoot),
      model: task.model,
      think: task.think,
      startedAt: task.startedAt,
      elapsedMs: now - new Date(task.startedAt).getTime(),
      steps: [...task.steps],
    });
  }

  res.json(result);
});

// ---- Single-page dashboard shell ----
app.get("/", (_req, res) => {
  res.type("html").send(APP_HTML);
});
app.get("/usage", (_req, res) => {
  // Alias: serve the same page but pre-select the Usage tab for backward compat.
  res.type("html").send(APP_HTML);
});
app.get("/active", (_req, res) => {
  // Alias: serve the same page but pre-select the Active tab (client-side already
  // checks location.pathname === '/active' -- this route just makes that reachable).
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
  html, body { margin: 0; padding: 0; }
  body { font: 14px -apple-system, sans-serif; background: #fff; color: #1a1a1a; }

  /* Tab bar */
  .tab-bar { display: flex; border-bottom: 2px solid #ddd; position: sticky; top: 0; background: #fff; z-index: 10; }
  @media (prefers-color-scheme: dark) { body { background: #14151a; color: #e8e8e8; } .tab-bar { border-bottom-color: #333; background: #14151a; } .panel { background: #14151a; } label, th { color: #ccc !important; } }
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

  /* Active tab styles */
  .project-row { cursor: pointer; transition: background .1s; }
  .project-row:hover { background: #f0f0f0; }
  @media (prefers-color-scheme: dark) { .project-row:hover { background: #2a2b34; } }
  .status-badge { display: inline-block; min-width: 72px; }
  .elapsed-text { color: #888; font-size: 12px; }

  /* Detail panel (inline) */
  .detail-panel { margin-top: 16px; padding: 16px; border-radius: 8px; border: 1px solid #ddd; display: none; }
  @media (prefers-color-scheme: dark) { .detail-panel { border-color: #444; background: #1c1d24; } }
  .detail-panel.visible { display: block; }
  .detail-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .detail-close { cursor: pointer; color: #888; font-size: 18px; background: none; border: none; padding: 0 4px; }
  @media (prefers-color-scheme: dark) { .detail-close { color: #aaa; } }
  .step-list { list-style: none; margin: 0; padding: 0; }
  .step-list li { padding: 4px 0; border-bottom: 1px solid #eee; font-size: 13px; font-family: monospace; }
  @media (prefers-color-scheme: dark) { .step-list li { border-color: #333; } }

  /* Active tab header */
  .active-header { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
  .active-status-text { font-size: 13px; color: #888; }

  @media (max-width: 700px) { .charts { grid-template-columns: 1fr; } }
</style>

<h1>local-worker-mcp</h1>

<div class="tab-bar" id="tabBar">
  <button class="tab-btn active" data-tab="config">Config</button>
  <button class="tab-btn" data-tab="usage">Usage</button>
  <button class="tab-btn" data-tab="active">Active</button>
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

  <h2>Model info <span class="hint">-- currently configured local model, updates if you change it</span></h2>
  <div class="stats" id="modelInfoCards"><div class="stat"><span class="n">...</span><span class="l">Loading</span></div></div>
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

  <h2>Claude (cloud) <span class="hint">-- from local Claude Code session transcripts on this machine, all projects</span></h2>
  <div class="stats" id="cloudStatCards"></div>
  <p class="hint">*Cloud total = input + output tokens only (excludes cache-read tokens, which are heavily-discounted context reuse and would otherwise dwarf everything).</p>
  <div class="charts">
    <div class="chart-box wide"><canvas id="chartLocalVsCloud"></canvas></div>
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

<!-- Active panel -->
<div class="panel" id="panel-active">
  <h2>Live Activity <span class="live-dot" id="activeLiveDot" style="display:none;"></span></h2>
  <p class="sub-hint">In-progress tasks and per-project idle/running status. Updates every ~2 seconds.</p>

  <h3>All known projects</h3>
  <table><thead><tr><th>Project</th><th>Status</th><th>Last used</th></tr></thead>
    <tbody id="projectStatusTable"></tbody>
  </table>

  <div class="detail-panel" id="activeDetail">
    <div class="detail-header">
      <strong id="activeDetailTitle"></strong>
      <span class="elapsed-text" id="activeDetailElapsed"></span>
      <button class="detail-close" id="activeDetailClose" title="Close">&times;</button>
    </div>
    <ol class="step-list" id="activeDetailSteps"></ol>
  </div>
</div>

<script>
(function() {
  /* ---- Tab switching ---- */
  var tabBar = document.getElementById('tabBar');
  var panels = { config: document.getElementById('panel-config'), usage: document.getElementById('panel-usage'), active: document.getElementById('panel-active') };
  var TAB_PATHS = { config: '/', usage: '/usage', active: '/active' };

  /* updateUrl defaults to true (normal tab clicks push a new history
   * entry so the URL always matches the visible tab -- reload or share the
   * link and you land back on the same tab). Pass false for the initial
   * render and for popstate handling, where the URL already reflects the
   * tab we're about to show and pushing again would create a duplicate
   * history entry / infinite loop. */
  function showTab(name, updateUrl) {
    for (var n in panels) { panels[n].classList.remove('visible'); }
    tabBar.querySelectorAll('.tab-btn').forEach(function(btn) {
      btn.classList.toggle('active', btn.getAttribute('data-tab') === name);
    });
    panels[name].classList.add('visible');

    if (updateUrl !== false && TAB_PATHS[name] && location.pathname !== TAB_PATHS[name]) {
      history.pushState({ tab: name }, '', TAB_PATHS[name]);
    }

    /* Lazy-initialize charts when the Usage tab is shown for the first time */
    if (name === 'usage' && !chartsReady) {
      showTabUsage();
    }

    /* Initialize active-tab logic when that tab is shown */
    if (name === 'active') {
      initActiveTab();
    }
  }
  tabBar.addEventListener('click', function(e) {
    var btn = e.target.closest('.tab-btn');
    if (!btn) return;
    showTab(btn.getAttribute('data-tab'));
  });
  /* Back/forward browser buttons should switch tabs too, not just change
   * the address bar -- re-derive the tab from the URL we just navigated to. */
  window.addEventListener('popstate', function() {
    if (location.pathname === '/usage') showTab('usage', false);
    else if (location.pathname === '/active') showTab('active', false);
    else showTab('config', false);
  });

  /* NOTE: which tab to start on (based on URL) is decided further down,
   * AFTER the Usage-tab variables/functions below (PALETTE, _rawRecords,
   * projectFilterSelect, showTabUsage, etc.) are declared -- showTab('usage')
   * synchronously calls showTabUsage(), which reads all of those, so calling
   * it here (before they exist) would throw on a direct /usage load. */

  /* ---- Config form loading/saving (unchanged semantics) ---- */
  var configForm = document.getElementById('configForm');
  var configStatus = document.getElementById('configStatus');

  fetch('/api/config').then(function(r) { return r.json(); }).then(function(cfg) {
    for (var key in cfg) {
      var el = configForm.elements[key];
      if (!el) continue;
      if (key === 'allowedRoots' || key === 'trustedParents') el.value = cfg[key].join('\\n');
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
      allowedRoots: String(fd.get('allowedRoots')).split('\\n').map(function(s) { return s.trim(); }).filter(Boolean),
      trustedParents: String(fd.get('trustedParents')).split('\\n').map(function(s) { return s.trim(); }).filter(Boolean),
      webSearchEnabled: fd.get('webSearchEnabled') === 'true',
    };
    fetch('/api/config', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) })
      .then(function(r) { return r.json(); }).then(function() {
        configStatus.textContent = 'Saved.';
        fetchModelInfo(); /* defaultModel (or ctx) may have just changed -- refresh the card */
        setTimeout(function(){ configStatus.textContent = ''; }, 2000);
      });
  });

  /* ---- Model info card: static metadata from Ollama (no model load) plus
   * an avg tokens/sec figure computed from OUR OWN recent local usage
   * records for that model (recomputed on every usage poll, no extra
   * network call needed for that part). */
  var _modelInfo = null;

  function fetchModelInfo() {
    return fetch('/api/model-info').then(function(r) { return r.json(); }).then(function(info) {
      if (info && !info.error) {
        _modelInfo = info;
        renderModelInfoCard();
      }
    }).catch(function() { /* Ollama may be briefly unreachable -- leave last-known card as-is */ });
  }

  function computeAvgTokPerSec(records, modelName) {
    var sumOut = 0, sumMs = 0;
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if (r.model !== modelName) continue;
      var genMs = r.totalDurationMs - r.loadDurationMs;
      if (genMs > 0) { sumOut += r.outputTokens; sumMs += genMs; }
    }
    return sumMs > 0 ? sumOut / (sumMs / 1000) : null;
  }

  function renderModelInfoCard() {
    var el = document.getElementById('modelInfoCards');
    if (!el || !_modelInfo) return;
    var info = _modelInfo;
    var avg = computeAvgTokPerSec((typeof _rawRecords !== 'undefined' && _rawRecords) || [], info.model);
    var expertsText = (info.expertCount && info.expertUsedCount)
      ? info.expertUsedCount + ' / ' + info.expertCount + ' experts per token (MoE)'
      : 'dense (no MoE)';

    el.innerHTML =
      '<div class="stat highlight"><span class="n">' + info.model + '</span><span class="l">Model in use</span></div>' +
      '<div class="stat"><span class="n">' + info.parameterSize + '</span><span class="l">Parameters</span></div>' +
      '<div class="stat"><span class="n">' + info.quantization + '</span><span class="l">Quantization</span></div>' +
      '<div class="stat"><span class="n">' + info.configuredCtx.toLocaleString() + '</span><span class="l">Context (max ' + info.maxContext.toLocaleString() + ')</span></div>' +
      '<div class="stat"><span class="n">' + expertsText + '</span><span class="l">Architecture</span></div>' +
      '<div class="stat"><span class="n">' + (avg ? avg.toFixed(1) + ' tok/s' : '\u2014') + '</span><span class="l">Avg. gen. speed (local calls this session)</span></div>';
  }

  fetchModelInfo();

  /* ---- Usage data & live charts ---- */
  var PALETTE = ['#6a55d6', '#2563c9', '#1f9d63', '#b5790a', '#cc3340', '#0891b2', '#c026d3'];

  var chartByProject, chartByModel, chartByDay, chartLocalVsCloud;
  var chartsReady = false; /* guard: are the Chart.js instances constructed yet? */
  var liveDot = document.getElementById('liveDot');
  var projectFilterSelect = document.getElementById('projectFilter');

  /* Create the three Chart.js instances ONCE (empty data to start); every
   * subsequent poll/filter change only mutates .data and calls .update(),
   * it never recreates them -- that's what avoids the flicker. */
  function initCharts() {
    if (chartsReady) return;
    chartsReady = true;

    chartByProject = new Chart(document.getElementById('chartByProject'), {
      type: 'bar',
      data: {
        labels: [],
        datasets: [
          { label: 'Calls', data: [], backgroundColor: PALETTE[0] },
          { label: 'Output tokens', data: [], backgroundColor: PALETTE[1], yAxisID: 'y1' },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { title: { display: true, text: 'Calls & tokens by project' } },
        scales: { y: { beginAtZero: true }, y1: { beginAtZero: true, position: 'right', grid: { drawOnChartArea: false } } },
      },
    });

    chartByModel = new Chart(document.getElementById('chartByModel'), {
      type: 'doughnut',
      data: { labels: [], datasets: [{ data: [], backgroundColor: PALETTE }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { title: { display: true, text: 'Calls by model' } } },
    });

    chartByDay = new Chart(document.getElementById('chartByDay'), {
      type: 'line',
      data: {
        labels: [],
        datasets: [{ label: 'Calls', data: [], borderColor: PALETTE[0], backgroundColor: PALETTE[0] + '33', fill: true, tension: 0.2 }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { title: { display: true, text: 'Calls over time' } },
        scales: { y: { beginAtZero: true } },
      },
    });

    chartLocalVsCloud = new Chart(document.getElementById('chartLocalVsCloud'), {
      type: 'bar',
      data: {
        labels: [],
        datasets: [
          { label: 'Local tokens (off-cloud)', data: [], backgroundColor: PALETTE[2] },
          { label: 'Cloud tokens (in+out)', data: [], backgroundColor: PALETTE[4] },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { title: { display: true, text: 'Local vs cloud tokens by project' } },
        scales: { y: { beginAtZero: true } },
      },
    });
  }

  /* Called when the Usage panel first becomes visible (or re-visible after
   * being on another tab) -- ensures charts exist and immediately applies
   * whatever data has already been fetched by the initial /api/usage load or polls. */
  function showTabUsage() {
    initCharts();
    /* Re-apply the latest raw records if any are available (they may have
     * been loaded from /api/usage before we ever switched to Usage tab). */
    applyUpdate(_rawRecords);
  }

  /* Project label helper -- the server resolves this per-record (via a
   * git-repo-root walk, which needs filesystem access the browser doesn't
   * have) and sends it as .project on every usage record / active task.
   * Prefer that; the path-string fallback below only covers the unlikely
   * case of a record missing it (older cached data, etc). */
  function projectLabel(record) {
    if (record && record.project) return record.project;
    var workspaceRoot = (record && record.workspaceRoot) || '';
    var parts = workspaceRoot.replace(/\\/+$/, '').split('/').filter(Boolean);
    if (parts.length <= 1) return parts.join('/') || workspaceRoot;
    return parts.slice(-2).join('/');
  }

  /* Format elapsed milliseconds to a human-readable string */
  function formatElapsed(ms) {
    var secs = Math.floor(ms / 1000);
    if (secs < 60) return secs + 's';
    var mins = Math.floor(secs / 60);
    if (mins < 60) return mins + 'm ' + (secs % 60) + 's';
    var hrs = Math.floor(mins / 60);
    return hrs + 'h ' + (mins % 60) + 'm';
  }

  /* Format relative time (last used ago) */
  function formatAgo(ms) {
    if (ms < 60 * 1000) return Math.max(1, Math.ceil(ms / 60000)) + 'm ago';
    var mins = Math.floor(ms / 60000);
    if (mins < 60 * 24) return Math.floor(mins / 60) + 'h ago';
    var hrs = Math.floor(mins / 60);
    return Math.floor(hrs / 24) + 'd ago';
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
      var project = projectLabel(r);
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
    if (!chartsReady) return;
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
      s.calls++; s.outputTokens += r.outputTokens; s.projects.add(projectLabel(r));
    }

    var sessionRows = [...bySessionMap.entries()]
      .map(function(e){ var s = e[1]; return '<tr><td>' + s.sessionId.slice(0,8) + '\u2026</td><td>' + s.calls + '</td><td>' + s.outputTokens.toLocaleString() + '</td><td>' + [...s.projects].join(', ') + '</td></tr>'; })
      .join('') || '<tr><td colspan="4">No usage yet.</td></tr>';
    document.getElementById('sessionTable').innerHTML = sessionRows;

    var recent = rawRecords.slice(-20).reverse();
    var recentRows = recent.map(function(r){
      return '<tr>' +
        '<td>' + new Date(r.timestamp).toLocaleString() + '</td>' +
        '<td>' + projectLabel(r) + '</td>' +
        '<td>' + r.model + '</td>' +
        '<td>' + r.think + '</td>' +
        '<td>' + r.toolCallSteps + '</td>' +
        '<td>' + r.outputTokens + '</td>' +
        '<td>' + (r.totalDurationMs / 1000).toFixed(1) + 's</td>' +
        '<td class="' + (r.success ? '' : 'fail') + '">' + (r.success ? 'ok' : 'error: ' + (r.errorMessage || '')) + '</td></tr>';
    }).join('') || '<tr><td colspan="8">No usage yet.</td></tr>';
    document.getElementById('recentTable').innerHTML = recentRows;
  }

  /* Build project filter dropdown options from the FULL (unfiltered) record
   * set -- always list every project, and keep whatever was selected before
   * the rebuild (a poll/filter-change must not silently reset it). */
  function buildProjectFilter(allRecords) {
    var current = projectFilterSelect.value || '__all__';
    var projects = new Set();
    for (var i = 0; i < allRecords.length; i++) projects.add(projectLabel(allRecords[i]));
    var opts = '<option value="__all__">All projects</option>';
    var sorted = Array.from(projects).sort();
    for (var j = 0; j < sorted.length; j++) {
      opts += '<option value="' + sorted[j] + '">' + sorted[j] + '</option>';
    }
    projectFilterSelect.innerHTML = opts;
    projectFilterSelect.value = (current === '__all__' || sorted.indexOf(current) >= 0) ? current : '__all__';
  }

  /* ---- Cloud (Claude Code) usage: aggregation + render, mirrors the local
   * equivalents above but sourced from /api/cloud-usage's raw records. */
  var _rawCloudRecords = [];

  function buildCloudAgg(cloudRecords, projectFilterName) {
    var filtered = (projectFilterName && projectFilterName !== '__all__')
      ? cloudRecords.filter(function(r){ return r.project === projectFilterName; })
      : cloudRecords;

    var byProjectMap = new Map();
    var totalInputTokens = 0, totalOutputTokens = 0;
    for (var i = 0; i < filtered.length; i++) {
      var r = filtered[i];
      totalInputTokens += r.inputTokens;
      totalOutputTokens += r.outputTokens;
      if (!byProjectMap.has(r.project)) byProjectMap.set(r.project, { calls: 0, inputTokens: 0, outputTokens: 0 });
      var p = byProjectMap.get(r.project);
      p.calls++; p.inputTokens += r.inputTokens; p.outputTokens += r.outputTokens;
    }

    return {
      totalCalls: filtered.length,
      totalInputTokens: totalInputTokens,
      totalOutputTokens: totalOutputTokens,
      totalCloudTokens: totalInputTokens + totalOutputTokens,
      byProject: [...byProjectMap.entries()].map(function(e){
        var k = e[0], v = e[1];
        return { project: k, calls: v.calls, inputTokens: v.inputTokens, outputTokens: v.outputTokens };
      }),
    };
  }

  function renderCloudStats(cloudAgg) {
    var el = document.getElementById('cloudStatCards');
    if (!el) return;
    el.innerHTML =
      '<div class="stat"><span class="n">' + cloudAgg.totalCalls.toLocaleString() + '</span><span class="l">Cloud messages</span></div>' +
      '<div class="stat"><span class="n">' + cloudAgg.totalInputTokens.toLocaleString() + '</span><span class="l">Input tokens</span></div>' +
      '<div class="stat"><span class="n">' + cloudAgg.totalOutputTokens.toLocaleString() + '</span><span class="l">Output tokens</span></div>' +
      '<div class="stat highlight"><span class="n">' + cloudAgg.totalCloudTokens.toLocaleString() + '</span><span class="l">Total cloud tokens</span></div>';
  }

  /* Update the "local vs cloud tokens by project" comparison chart in place.
   * Unions project names from both sides -- a project delegated locally but
   * never touched by Claude directly (or vice versa) still gets a bar,
   * with 0 for whichever side has no data. */
  function updateLocalVsCloudChart(localAgg, cloudAgg) {
    if (!chartsReady) return;
    var localMap = {};
    for (var i = 0; i < localAgg.byProject.length; i++) {
      var lp = localAgg.byProject[i];
      localMap[lp.project] = lp.outputTokens + lp.promptTokens;
    }
    var cloudMap = {};
    for (var j = 0; j < cloudAgg.byProject.length; j++) {
      var cp = cloudAgg.byProject[j];
      cloudMap[cp.project] = cp.inputTokens + cp.outputTokens;
    }

    var allProjects = new Set(Object.keys(localMap).concat(Object.keys(cloudMap)));
    var sorted = Array.from(allProjects).sort();

    chartLocalVsCloud.data.labels = sorted;
    chartLocalVsCloud.data.datasets[0].data = sorted.map(function(p){ return localMap[p] || 0; });
    chartLocalVsCloud.data.datasets[1].data = sorted.map(function(p){ return cloudMap[p] || 0; });
    chartLocalVsCloud.update('none');
  }

  /* Apply the selected project filter and re-render everything. "rawRecords"
   * is always the FULL unfiltered list from the server -- filtering for
   * display happens in here, never destructively on the stored list. */
  function applyUpdate(rawRecords) {
    buildProjectFilter(rawRecords); /* always reflects every known project */
    var projectName = projectFilterSelect.value;
    var records = (projectName && projectName !== '__all__')
      ? rawRecords.filter(function(r){ return projectLabel(r) === projectName; })
      : rawRecords;
    var agg = buildAgg(records);
    renderStats(agg);

    var cloudAgg = buildCloudAgg(_rawCloudRecords, projectName);
    renderCloudStats(cloudAgg);

    if (!agg.totalCalls) {
      document.getElementById('sessionTable').innerHTML = '<tr><td colspan="4">No usage yet.</td></tr>';
      document.getElementById('recentTable').innerHTML = '<tr><td colspan="8">No usage yet.</td></tr>';
      if (chartsReady) {
        chartByProject.data.labels = []; chartByProject.data.datasets[0].data = []; chartByProject.data.datasets[1].data = [];
        chartByModel.data.labels = []; chartByModel.data.datasets[0].data = [];
        chartByDay.data.labels = []; chartByDay.data.datasets[0].data = [];
        chartByProject.update('none');
        chartByModel.update('none');
        chartByDay.update('none');
      }
    } else {
      updateCharts(agg);
      renderTables(records, agg);
    }

    /* Local-vs-cloud comparison chart updates regardless of whether local
     * has any calls -- a project can be cloud-only (no delegations yet). */
    updateLocalVsCloudChart(agg, cloudAgg);
  }

  /* ---- Active tab state (declared early so the initial-url-detection code
   * below can safely reference it if /active is loaded) ---- */
  var activeLiveDot = document.getElementById('activeLiveDot');
  var _activeTasks = [];
  var _allKnownProjects = {}; /* project -> { lastUsed: ISO string } */
  var _detailTaskId = null;

  /* Refresh active-tab data by polling /api/active + merging with usage data */
  function refreshActiveTab() {
    fetch('/api/active').then(function(r) { return r.json(); }).then(function(data) {
      _activeTasks = data || [];

      /* Also merge in known projects from the usage API for idle status */
      if (_allKnownProjects === undefined || Object.keys(_allKnownProjects).length === 0 && _rawRecords.length > 0) {
        for (var i = 0; i < _rawRecords.length; i++) {
          var proj = projectLabel(_rawRecords[i]);
          if (!_allKnownProjects[proj]) {
            _allKnownProjects[proj] = { lastUsed: _rawRecords[i].timestamp };
          } else {
            if (_rawRecords[i].timestamp > _allKnownProjects[proj].lastUsed) {
              _allKnownProjects[proj].lastUsed = _rawRecords[i].timestamp;
            }
          }
        }
      }

      renderProjectStatus();

      /* Update detail panel if one is open */
      if (_detailTaskId) {
        updateDetailPanel(_detailTaskId);
      }

      var hasActive = _activeTasks.length > 0;
      activeLiveDot.style.display = hasActive ? 'inline-block' : 'none';
    }).catch(function() { /* ignore poll errors */ });
  }

  /* Render the per-project status table */
  function renderProjectStatus() {
    var tbody = document.getElementById('projectStatusTable');
    if (!tbody) return;

    var allProjects = new Set();

    /* Collect from active tasks */
    for (var i = 0; i < _activeTasks.length; i++) {
      allProjects.add(projectLabel(_activeTasks[i]));
    }

    /* Collect from known projects */
    for (var k in _allKnownProjects) {
      if (_allKnownProjects.hasOwnProperty(k)) allProjects.add(k);
    }

    var now = Date.now();
    var rows = [];

    var sorted = Array.from(allProjects).sort();
    for (var j = 0; j < sorted.length; j++) {
      var proj = sorted[j];
      /* Find the active task for this project */
      var activeTask = null;
      for (var i = 0; i < _activeTasks.length; i++) {
        if (projectLabel(_activeTasks[i]) === proj) {
          activeTask = _activeTasks[i];
          break;
        }
      }

      var statusHtml, agoHtml;
      if (activeTask) {
        statusHtml = '<span class="status-badge">\\ud83d\\udfe2 running \\u2014 ' + formatElapsed(activeTask.elapsedMs) + '</span>';
        agoHtml = '\u2014';
      } else if (_allKnownProjects[proj]) {
        var lastUsed = new Date(_allKnownProjects[proj].lastUsed).getTime();
        var ago = now - lastUsed;
        statusHtml = '<span class="status-badge">\\u26aa idle</span>';
        agoHtml = formatAgo(ago);
      } else {
        statusHtml = '<span class="status-badge">\\u26aa idle</span>';
        agoHtml = '\u2014';
      }

      rows.push('<tr class="project-row"' + (activeTask ? ' data-task-id="' + activeTask.id + '"' : '') + '>' +
        '<td>' + proj + '</td>' +
        '<td>' + statusHtml + '</td>' +
        '<td class="elapsed-text">' + agoHtml + '</td></tr>');
    }

    if (rows.length === 0) {
      rows.push('<tr><td colspan="3">No usage yet.</td></tr>');
    }

    tbody.innerHTML = rows.join('');

    /* Attach click handlers to running projects */
    var rowEls = tbody.querySelectorAll('.project-row[data-task-id]');
    for (var r = 0; r < rowEls.length; r++) {
      rowEls[r].addEventListener('click', function() {
        var id = this.getAttribute('data-task-id');
        showDetail(id);
      });
    }
  }

  /* Show the detail panel for a running task */
  function showDetail(taskId) {
    _detailTaskId = taskId;
    var panel = document.getElementById('activeDetail');
    if (panel) panel.classList.add('visible');
    updateDetailPanel(taskId);
  }

  function hideDetail() {
    _detailTaskId = null;
    var panel = document.getElementById('activeDetail');
    if (panel) panel.classList.remove('visible');
  }

  function updateDetailPanel(taskId) {
    var task = null;
    for (var i = 0; i < _activeTasks.length; i++) {
      if (_activeTasks[i].id === taskId) { task = _activeTasks[i]; break; }
    }
    if (!task) return;

    var titleEl = document.getElementById('activeDetailTitle');
    var elapsedEl = document.getElementById('activeDetailElapsed');
    var stepsEl = document.getElementById('activeDetailSteps');

    if (titleEl) titleEl.textContent = projectLabel(task);
    if (elapsedEl) elapsedEl.textContent = 'Elapsed: ' + formatElapsed(task.elapsedMs) + ' \\u2014 Model: ' + task.model + (task.think ? ' (thinking)' : '');

    var steps = task.steps || [];
    var stepHtmls = [];
    for (var i = 0; i < steps.length; i++) {
      var ts = new Date(steps[i].timestamp);
      var timeStr = ts.toLocaleTimeString('en-US', { hour12: false });
      stepHtmls.push('<li><span style="color:#888">' + timeStr + '</span> \u2014 ' + escapeHtml(steps[i].message) + '</li>');
    }

    if (stepHtmls.length === 0) {
      stepHtmls = ['<li style="color:#888">Waiting for first step\u2026</li>'];
    }

    if (stepsEl) stepsEl.innerHTML = stepHtmls.join('');

    /* Auto-scroll to bottom */
    if (stepsEl) {
      stepsEl.scrollTop = stepsEl.scrollHeight;
    }
  }

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* Active tab initialization -- only runs when the tab is first shown */
  var _activeInitialized = false;

  function initActiveTab() {
    if (_activeInitialized) return;
    _activeInitialized = true;

    /* Close handler */
    document.getElementById('activeDetailClose').addEventListener('click', hideDetail);

    /* Initial render using whatever usage data we already have */
    refreshProjectListFromUsage();

    /* Start fast polling for active tasks (separate from the 5s usage poll) */
    startActivePolling();
  }

  function refreshProjectListFromUsage() {
    if (_rawRecords.length > 0) {
      for (var i = 0; i < _rawRecords.length; i++) {
        var proj = projectLabel(_rawRecords[i]);
        if (!_allKnownProjects[proj]) {
          _allKnownProjects[proj] = { lastUsed: _rawRecords[i].timestamp };
        } else {
          if (_rawRecords[i].timestamp > _allKnownProjects[proj].lastUsed) {
            _allKnownProjects[proj].lastUsed = _rawRecords[i].timestamp;
          }
        }
      }
    }
  }

  var _activePollTimer = null;
  function startActivePolling() {
    if (_activePollTimer) return;
    (function poll() {
      refreshActiveTab();
      _activePollTimer = setTimeout(poll, 2000);
    })();
  }

  /* ---- Usage data polling (existing) ---- */
  var _rawRecords = []; /* store for table rendering */

  function fetchUsageAndCloud() {
    return Promise.all([
      fetch('/api/usage').then(function(r){ return r.json(); }),
      /* Cloud usage is best-effort -- if it 404s on an older server or the
       * transcript scan hiccups, fall back to empty rather than breaking
       * the whole Usage tab. */
      fetch('/api/cloud-usage').then(function(r){ return r.json(); }).catch(function(){ return { records: [] }; }),
    ]);
  }

  fetchUsageAndCloud().then(function(results) {
    var data = results[0];
    var cloudData = results[1];
    _rawRecords = data.records || [];
    _rawCloudRecords = cloudData.records || [];

    /* Rebuild the known-projects map so Active tab can merge with /api/active */
    refreshProjectListFromUsage();

    buildProjectFilter(_rawRecords);
    applyUpdate(_rawRecords);
    renderModelInfoCard(); /* recompute avg tok/s now that usage records are in */

    projectFilterSelect.addEventListener('change', function() { applyUpdate(_rawRecords); });

    /* Live poll every 5 seconds */
    (function poll() {
      fetchUsageAndCloud().then(function(results) {
        var data = results[0];
        var cloudData = results[1];
        _rawRecords = data.records || [];
        _rawCloudRecords = cloudData.records || [];

        /* Rebuild known-projects map so Active tab stays current */
        refreshProjectListFromUsage();

        var currentVal = projectFilterSelect.value;
        applyUpdate(_rawRecords); /* re-apply the currently-selected filter */
        renderModelInfoCard(); /* keep avg tok/s current as new local calls land */

        if (_rawRecords.length > 0 || true) {
          liveDot.style.display = 'inline-block';
        }
      }).catch(function(){ /* ignore poll errors */ });

      setTimeout(poll, 5000);
    })();

    liveDot.style.display = 'inline-block';
  });

  /* Determine which tab to start on based on URL -- now that every Usage-tab
   * variable/function above is defined, it's safe for this to synchronously
   * trigger showTabUsage() via showTab('usage'). */
  if (location.pathname === '/usage') showTab('usage', false);
  else if (location.pathname === '/active') showTab('active', false);
  else showTab('config', false);

})();
</script>
`;

app.listen(config.port, () => {
  console.log(`local-worker-mcp listening on http://localhost:${config.port} (MCP endpoint: /mcp, dashboard: /)`);
});
