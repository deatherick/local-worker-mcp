# local-worker-mcp

An MCP server that exposes a local Ollama model (e.g. Qwen3.6) as an
**agentic worker** -- with its own tool-calling loop (read/list/write
files inside an allow-listed folder, search the web, get the real current
date/time) -- for use from **any MCP client**: Claude Code, Claude
Desktop, Continue, Cursor, whatever.

"Foreman/worker" pattern: the MCP client (you, or a larger LLM like
Claude) keeps the full context and decides what's worth delegating; this
server only ever executes the one scoped, well-specified task it's handed,
with no memory of anything else.

## Why this exists

Grew out of using Continue.dev with local models and hitting real
instability in that extension (it hangs). Instead of continuing to patch
a VS Code extension, this project separates the concern: a plain MCP
server, no GUI in the loop, talking straight to Ollama.

## Architecture

```
MCP client (Claude Code, Claude Desktop, ...)
        │  tools/call "delegate_task"
        ▼
local-worker-mcp (this server, streamable HTTP)
        │  /api/chat with tools attached
        ▼
Ollama (localhost:11434, or remote over Tailscale)
        │  tool_calls: read_file / write_file / search_web / ...
        ▼
local-worker-mcp executes each tool call, scoped to workspace_root
```

## Security (read this before using it)

- **`allowedRoots`** in the config is a real allow-list: the server
  refuses any `workspace_root` or path that isn't literally inside one of
  those folders -- empty by default, by design. You have to explicitly
  add folders via the dashboard or the config file before the worker can
  touch anything.
- Every write (`write_file`) is logged to `~/.local-worker-mcp/activity.log`
  with the full path and size -- so you can audit what the model touched
  afterward.
- Explicitly tested that a directory-escape attempt (`../../etc/...`) is
  rejected by the server itself, not just "trusted" to the model behaving.
- The local model can get things wrong (see `~/local-llm-bench/RESULTS.md`
  for real data on when and how much) -- always review `steps` in the
  response before trusting a file change.

## Install / run

```bash
git clone https://github.com/deatherick/local-worker-mcp.git
cd local-worker-mcp
npm install
npm run build
node dist/server.js
```

Open `http://localhost:8787` for the config dashboard (model, context
length, allowed folders, etc. -- saved to `~/.local-worker-mcp/config.json`).

To run it centralized (one Mac with Ollama, reachable from other machines
over Tailscale/LAN) and connect from an MCP client on another machine,
point that client's MCP config at `http://<host>:8787/mcp`
(`streamable-http` transport), e.g. in Continue:

```yaml
mcpServers:
  - name: Local Worker
    type: streamable-http
    url: http://your-host.your-tailnet.ts.net:8787/mcp
```

## Exposed tools

- `delegate_task(task, workspace_root, model?, think?, max_steps?)` --
  runs the full loop. Returns `finalText` plus every `steps` entry (which
  tool it called, with what arguments, and the result) so you can audit
  before trusting the outcome.
- `list_worker_config()` -- current config, so a client can confirm which
  model/folders it's talking to before delegating.

## Development

```bash
npm run dev   # build + start
```

## Roadmap / not included yet

- Proxying to other existing MCP servers (Git, Context7) from inside the
  worker's own loop -- today it only has its own `search_web` plus the
  native file tools.
- A shell-command tool -- deliberately NOT included in v0.1 given the
  risk; if added, it needs its own allow-list of permitted commands, not
  free execution.
- Auth on the HTTP endpoint -- currently assumes it runs behind a trusted
  network (Tailscale/LAN), not exposed to the open internet.

## License

Apache 2.0.
