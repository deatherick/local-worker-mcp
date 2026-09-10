import fs from "fs";
import path from "path";
import os from "os";
import { projectLabel } from "./usage.js";

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

export interface CloudUsageRecord {
  timestamp: string;
  sessionId: string;
  cwd: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

/**
 * Reads every Claude Code session transcript on this machine
 * (~/.claude/projects/<project>/<session-id>.jsonl) and extracts one record
 * per assistant message that carries a `usage` block.
 *
 * IMPORTANT: Claude Code re-writes/re-logs the same assistant message
 * multiple times as a turn progresses (steering, tool-call follow-ups,
 * etc.) -- verified empirically: one session had 348 usage-bearing lines
 * but only 168 unique `message.id` values. Without deduping by message id,
 * token totals would be inflated roughly 2x. We keep only the first
 * occurrence of each message id per session file.
 */
export function readCloudUsage(): CloudUsageRecord[] {
  const records: CloudUsageRecord[] = [];
  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) return records;

  let projectDirs: string[];
  try {
    projectDirs = fs
      .readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return records;
  }

  for (const projDir of projectDirs) {
    const fullProjDir = path.join(CLAUDE_PROJECTS_DIR, projDir);
    let files: string[];
    try {
      files = fs.readdirSync(fullProjDir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }

    for (const file of files) {
      const sessionId = file.replace(/\.jsonl$/, "");
      const filePath = path.join(fullProjDir, file);
      let raw: string;
      try {
        raw = fs.readFileSync(filePath, "utf8");
      } catch {
        continue;
      }

      const seenMessageIds = new Set<string>();
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        let obj: any;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        const msg = obj.message;
        if (!msg || typeof msg !== "object" || !msg.usage) continue;

        const msgId: string | undefined = msg.id;
        if (msgId) {
          if (seenMessageIds.has(msgId)) continue;
          seenMessageIds.add(msgId);
        }

        const usage = msg.usage;
        records.push({
          timestamp: obj.timestamp || "",
          sessionId,
          cwd: obj.cwd || "",
          model: msg.model || "unknown",
          inputTokens: usage.input_tokens || 0,
          outputTokens: usage.output_tokens || 0,
          cacheCreationInputTokens: usage.cache_creation_input_tokens || 0,
          cacheReadInputTokens: usage.cache_read_input_tokens || 0,
        });
      }
    }
  }

  return records;
}

export interface CloudUsageSummary {
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  // input + output only -- the direct "new work generated" figure, comparable
  // to the local dashboard's totalTokensOffCloud. Cache-read tokens are
  // excluded from this headline number since they're heavily-discounted
  // context reuse, not fresh generation, and can dwarf everything else.
  totalCloudTokens: number;
  byProject: { project: string; calls: number; inputTokens: number; outputTokens: number }[];
  byDay: { day: string; calls: number; inputTokens: number; outputTokens: number }[];
  byModel: { model: string; calls: number; inputTokens: number; outputTokens: number }[];
  records: (CloudUsageRecord & { project: string })[];
}

export function summarizeCloudUsage(records: CloudUsageRecord[]): CloudUsageSummary {
  const byProjectMap = new Map<string, { calls: number; inputTokens: number; outputTokens: number }>();
  const byDayMap = new Map<string, { calls: number; inputTokens: number; outputTokens: number }>();
  const byModelMap = new Map<string, { calls: number; inputTokens: number; outputTokens: number }>();

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheCreationTokens = 0;

  for (const r of records) {
    const project = r.cwd ? projectLabel(r.cwd) : "(unknown)";
    const day = r.timestamp.slice(0, 10);

    totalInputTokens += r.inputTokens;
    totalOutputTokens += r.outputTokens;
    totalCacheReadTokens += r.cacheReadInputTokens;
    totalCacheCreationTokens += r.cacheCreationInputTokens;

    const p = byProjectMap.get(project) || { calls: 0, inputTokens: 0, outputTokens: 0 };
    p.calls++;
    p.inputTokens += r.inputTokens;
    p.outputTokens += r.outputTokens;
    byProjectMap.set(project, p);

    const d = byDayMap.get(day) || { calls: 0, inputTokens: 0, outputTokens: 0 };
    d.calls++;
    d.inputTokens += r.inputTokens;
    d.outputTokens += r.outputTokens;
    byDayMap.set(day, d);

    const m = byModelMap.get(r.model) || { calls: 0, inputTokens: 0, outputTokens: 0 };
    m.calls++;
    m.inputTokens += r.inputTokens;
    m.outputTokens += r.outputTokens;
    byModelMap.set(r.model, m);
  }

  return {
    totalCalls: records.length,
    totalInputTokens,
    totalOutputTokens,
    totalCacheReadTokens,
    totalCacheCreationTokens,
    totalCloudTokens: totalInputTokens + totalOutputTokens,
    byProject: [...byProjectMap.entries()].map(([project, v]) => ({ project, ...v })).sort((a, b) => b.calls - a.calls),
    byDay: [...byDayMap.entries()].map(([day, v]) => ({ day, ...v })).sort((a, b) => a.day.localeCompare(b.day)),
    byModel: [...byModelMap.entries()].map(([model, v]) => ({ model, ...v })).sort((a, b) => b.calls - a.calls),
    records: records.map((r) => ({ ...r, project: r.cwd ? projectLabel(r.cwd) : "(unknown)" })),
  };
}
