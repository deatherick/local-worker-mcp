import { WorkerConfig } from "./config.js";

export interface ModelInfo {
  model: string;
  family: string;
  parameterSize: string; // e.g. "35.5B" -- Ollama's own human-readable string, not recomputed
  quantization: string; // e.g. "Q4_K_M"
  configuredCtx: number; // your defaultCtx setting
  maxContext: number; // the model's own max context length
  expertCount: number | null; // null for a dense (non-MoE) model
  expertUsedCount: number | null;
}

/**
 * Queries Ollama's /api/show for whatever model is CURRENTLY configured as
 * config.defaultModel -- this is a metadata-only call (license/template/
 * architecture info), it does NOT load the model into memory or cost GPU
 * time, so it's safe to call on every dashboard load / after every config
 * save without worrying about triggering a slow cold-load.
 *
 * Deliberately does NOT attempt to compute a precise "active parameters
 * per token" number for MoE models -- that requires knowing the split
 * between always-active dense layers (attention, embeddings, shared
 * expert) and the sparsely-routed expert FFN blocks, which isn't reliably
 * derivable from the metadata Ollama exposes. Showing expertUsedCount /
 * expertCount as-is (the real numbers) is more honest than a made-up
 * approximation presented as fact.
 */
export async function getModelInfo(config: WorkerConfig): Promise<ModelInfo> {
  const resp = await fetch(`${config.ollamaHost}/api/show`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: config.defaultModel }),
  });
  if (!resp.ok) {
    throw new Error(`Ollama /api/show ${resp.status}: ${await resp.text()}`);
  }
  const body: any = await resp.json();
  const details = body.details || {};
  const family: string = details.family || body.model_info?.["general.architecture"] || "unknown";
  const modelInfo = body.model_info || {};

  return {
    model: config.defaultModel,
    family,
    parameterSize: details.parameter_size || "unknown",
    quantization: details.quantization_level || "unknown",
    configuredCtx: config.defaultCtx,
    maxContext: modelInfo[`${family}.context_length`] || 0,
    expertCount: modelInfo[`${family}.expert_count`] ?? null,
    expertUsedCount: modelInfo[`${family}.expert_used_count`] ?? null,
  };
}
