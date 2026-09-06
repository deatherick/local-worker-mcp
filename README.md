# local-worker-mcp

Un servidor MCP que expone un modelo de Ollama local (por ejemplo,
Qwen3.6) como un **obrero agéntico** -- con su propio ciclo de
tool-calling (leer/listar/escribir archivos dentro de una carpeta
permitida, buscar en la web, fecha/hora real) -- para usar desde
**cualquier cliente MCP**: Claude Code, Claude Desktop, Continue, Cursor,
lo que sea.

Patrón "capataz/obrero": el cliente MCP (tú, o un LLM más grande como
Claude) mantiene el contexto completo y decide qué delegar; este servidor
solo ejecuta la tarea puntual y bien especificada que se le manda, sin
memoria de nada más.

## Por qué existe

Nace de usar Continue.dev con modelos locales y toparse con inestabilidad
real de esa extensión (se cuelga). En vez de seguir parchando una
extensión de VS Code, este proyecto separa el problema: un servidor MCP
plano, sin GUI de por medio, hablando directo con Ollama.

## Arquitectura

```
Cliente MCP (Claude Code, Claude Desktop, ...)
        │  tools/call "delegate_task"
        ▼
local-worker-mcp (este servidor, HTTP streamable)
        │  /api/chat con tools attached
        ▼
Ollama (localhost:11434, o remoto vía Tailscale)
        │  tool_calls: read_file / write_file / search_web / ...
        ▼
local-worker-mcp ejecuta cada tool call, scoped a workspace_root
```

## Seguridad (léelo antes de usarlo)

- **`allowedRoots`** en la config es una lista blanca real: el servidor
  rechaza cualquier `workspace_root` o ruta que no esté literalmente
  dentro de una de esas carpetas -- por diseño, vacía por default. Tienes
  que agregar carpetas explícitamente vía el dashboard o el config file
  antes de que el obrero pueda tocar nada.
- Cada escritura (`write_file`) queda registrada en
  `~/.local-worker-mcp/activity.log` con ruta completa y tamaño -- para
  poder auditar qué tocó el modelo después.
- Probado explícitamente que un intento de escape de directorio
  (`../../etc/...`) es rechazado por el servidor, no solo "confiado" a que
  el modelo se porte bien.
- El modelo local puede equivocarse (ver `~/local-llm-bench/RESULTS.md`
  para datos reales de cuándo y cuánto) -- revisa siempre `steps` en la
  respuesta antes de confiar en un cambio de archivo.

## Instalación / uso

```bash
git clone https://github.com/deatherick/local-worker-mcp.git
cd local-worker-mcp
npm install
npm run build
node dist/server.js
```

Abre `http://localhost:8787` para el dashboard de configuración (modelo,
context length, carpetas permitidas, etc. -- se guarda en
`~/.local-worker-mcp/config.json`).

Para correrlo centralizado (una Mac con Ollama, alcanzable desde otras
máquinas por Tailscale/LAN) y conectarte desde un cliente MCP en otra
máquina, apunta la config de MCP de ese cliente a
`http://<host>:8787/mcp` (transporte `streamable-http`), por ejemplo en
Continue:

```yaml
mcpServers:
  - name: Local Worker
    type: streamable-http
    url: http://ericks-mac-studio.taile7bd43.ts.net:8787/mcp
```

## Tools expuestas

- `delegate_task(task, workspace_root, model?, think?, max_steps?)` --
  corre el ciclo completo. Devuelve `finalText` + cada `steps` (qué tool
  llamó, con qué argumentos, y el resultado) para que puedas auditar antes
  de confiar en el resultado.
- `list_worker_config()` -- config actual, para que un cliente pueda
  confirmar contra qué modelo/carpetas está hablando antes de delegar.

## Desarrollo

```bash
npm run dev   # build + start
```

## Roadmap / no incluido todavía

- Proxy hacia otros servidores MCP existentes (Git, Context7) desde
  dentro del ciclo del obrero -- hoy solo tiene `search_web` propio y las
  herramientas de archivo nativas.
- Un tool que corra comandos de shell -- deliberadamente NO incluido en
  v0.1 por el riesgo; si se agrega, necesita su propia lista blanca de
  comandos permitidos, no ejecución libre.
- Autenticación en el endpoint HTTP -- hoy asume que corre detrás de una
  red de confianza (Tailscale/LAN), no expuesto a internet abierto.

## Licencia

Apache 2.0.
