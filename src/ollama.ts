import { WorkerConfig } from "./config.js";
import { buildToolDefs, executeTool, ToolContext } from "./tools.js";

interface RunTaskParams {
  task: string;
  workspaceRoot: string;
  model?: string;
  think?: boolean;
  maxSteps?: number;
}

interface RunTaskResult {
  finalText: string;
  steps: { tool: string; args: any; result: string }[];
  modelUsed: string;
  metrics: {
    totalDurationMs: number;
    loadDurationMs: number;
    promptTokens: number;
    outputTokens: number;
  };
}

/**
 * Runs a full local tool-calling loop: sends the task to Ollama with the
 * worker's tool definitions attached, executes whatever tools the model
 * calls (scoped to workspaceRoot via resolveSafePath), feeds results back,
 * and keeps going until the model stops calling tools or maxSteps is hit.
 */
export async function runDelegatedTask(config: WorkerConfig, params: RunTaskParams): Promise<RunTaskResult> {
  const model = params.model || config.defaultModel;
  const think = params.think ?? config.defaultThink;
  const maxSteps = params.maxSteps ?? 8;
  const tools = buildToolDefs(config.webSearchEnabled);
  const ctx: ToolContext = { config, workspaceRoot: params.workspaceRoot };

  const messages: any[] = [
    {
      role: "user",
      content: `${params.task}\n\n(Your workspace root for file tools is: ${params.workspaceRoot} -- all paths are relative to it.)`,
    },
  ];

  const steps: RunTaskResult["steps"] = [];
  const metrics = { totalDurationMs: 0, loadDurationMs: 0, promptTokens: 0, outputTokens: 0 };

  for (let step = 0; step < maxSteps; step++) {
    const payload: any = {
      model,
      stream: false,
      keep_alive: 60, // stay warm across steps of the same task; caller's next delegate_task call unloads via a trailing 0-keepalive ping if desired
      messages,
      tools,
      options: { num_ctx: config.defaultCtx, num_predict: config.defaultMaxTokens },
    };
    if (think !== undefined) payload.think = think;

    const resp = await fetch(`${config.ollamaHost}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      throw new Error(`Ollama /api/chat ${resp.status}: ${await resp.text()}`);
    }
    const body: any = await resp.json();
    const msg = body.message;

    metrics.totalDurationMs += (body.total_duration || 0) / 1e6;
    metrics.loadDurationMs += (body.load_duration || 0) / 1e6;
    metrics.promptTokens += body.prompt_eval_count || 0;
    metrics.outputTokens += body.eval_count || 0;

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return { finalText: msg.content || "", steps, modelUsed: model, metrics };
    }

    messages.push({ role: "assistant", content: msg.content || "", tool_calls: msg.tool_calls });

    for (const call of msg.tool_calls) {
      const toolName = call.function.name;
      let args = call.function.arguments;
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          /* leave as-is, executeTool will likely fail loudly, which is fine */
        }
      }
      let result: string;
      try {
        result = await executeTool(toolName, args, ctx);
      } catch (e: any) {
        result = `ERROR: ${e.message || e}`;
      }
      steps.push({ tool: toolName, args, result });
      messages.push({ role: "tool", content: result });
    }
  }

  return {
    finalText: "(hit maxSteps without a final answer -- see steps for what it was doing)",
    steps,
    modelUsed: model,
    metrics,
  };
}
