import fs from "fs";
import path from "path";
import os from "os";

const CONFIG_DIR = path.join(os.homedir(), ".local-worker-mcp");
const USAGE_PATH = path.join(CONFIG_DIR, "usage.jsonl");

export interface UsageRecord {
  timestamp: string; // ISO
  sessionId?: string;
  workspaceRoot: string;
  model: string;
  think: boolean;
  success: boolean;
  errorMessage?: string;
  toolCallSteps: number;
  totalDurationMs: number;
  loadDurationMs: number;
  promptTokens: number;
  outputTokens: number;
}

export function logUsage(record: UsageRecord): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.appendFileSync(USAGE_PATH, JSON.stringify(record) + "\n");
}

export function readUsage(): UsageRecord[] {
  if (!fs.existsSync(USAGE_PATH)) return [];
  return fs
    .readFileSync(USAGE_PATH, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l) as UsageRecord;
      } catch {
        return null;
      }
    })
    .filter((r): r is UsageRecord => r !== null);
}

/** Walk up from `startDir` looking for a `.git` entry (dir or file -- git
 * worktrees use a file), returning the first directory that has one, or
 * null if none is found before the filesystem root. Memoized since the
 * same workspaceRoot repeats across many usage records/active tasks. */
const gitRootCache = new Map<string, string | null>();
function findGitRoot(startDir: string): string | null {
  if (gitRootCache.has(startDir)) return gitRootCache.get(startDir)!;
  let dir = startDir;
  let result: string | null = null;
  while (true) {
    try {
      if (fs.existsSync(path.join(dir, ".git"))) {
        result = dir;
        break;
      }
    } catch {
      break; // fail-safe: treat as "no git root found" rather than throwing
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  gitRootCache.set(startDir, result);
  return result;
}

/** Human-friendly, STABLE project label from a workspace_root path.
 * Resolves to the nearest git repo root first (so the same project always
 * groups together regardless of which subfolder a delegate_task call
 * targeted), then uses the last two path segments of that root for
 * disambiguation (e.g. "pokedex-median/webapp") so different projects
 * sharing a leaf folder name don't collide. Falls back to the raw path's
 * last two segments if no .git is found (e.g. not a git repo yet). */
export function projectLabel(workspaceRoot: string): string {
  const gitRoot = findGitRoot(workspaceRoot);
  const base = gitRoot || workspaceRoot;
  const cleaned = base.replace(/\/+$/, "");
  const segments = cleaned.split("/").filter(Boolean);
  if (segments.length === 0) return base || "/";
  if (segments.length === 1) return segments[0];
  return segments.slice(-2).join("/");
}

export interface UsageSummary {
  totalCalls: number;
  totalSuccesses: number;
  totalFailures: number;
  totalOutputTokens: number;
  totalPromptTokens: number;
  totalTokensOffCloud: number; // promptTokens + outputTokens -- proxy for "tokens that didn't hit a cloud API"
  totalDurationMs: number;
  byProject: { project: string; calls: number; outputTokens: number; promptTokens: number; durationMs: number }[];
  byDay: { day: string; calls: number; outputTokens: number; promptTokens: number }[];
  byModel: { model: string; calls: number; outputTokens: number }[];
  bySession: { sessionId: string; calls: number; outputTokens: number; projects: string[] }[];
  recent: (UsageRecord & { project: string })[];
  records: (UsageRecord & { project: string })[];
}

/**
 * "Tokens off cloud" is an ESTIMATE, not a precise cost calculation: it's the
 * volume of prompt+output tokens the local worker processed instead of a
 * cloud model doing the same work. Qwen3.6 and a cloud model wouldn't
 * necessarily produce byte-identical output for the same task, so treat this
 * as "how much work got offloaded", not a guaranteed dollar-for-dollar swap.
 */
export function summarizeUsage(records: UsageRecord[]): UsageSummary {
  const byProjectMap = new Map<string, { calls: number; outputTokens: number; promptTokens: number; durationMs: number }>();
  const byDayMap = new Map<string, { calls: number; outputTokens: number; promptTokens: number }>();
  const bySessionMap = new Map<string, { calls: number; outputTokens: number; projects: Set<string> }>();
  const byModelMap = new Map<string, { calls: number; outputTokens: number }>();

  let totalOutputTokens = 0;
  let totalPromptTokens = 0;
  let totalDurationMs = 0;
  let totalSuccesses = 0;
  let totalFailures = 0;

  for (const r of records) {
    const project = projectLabel(r.workspaceRoot);
    const day = r.timestamp.slice(0, 10); // YYYY-MM-DD
    const session = r.sessionId || "unknown";

    if (r.success) totalSuccesses++;
    else totalFailures++;
    totalOutputTokens += r.outputTokens;
    totalPromptTokens += r.promptTokens;
    totalDurationMs += r.totalDurationMs;

    const p = byProjectMap.get(project) || { calls: 0, outputTokens: 0, promptTokens: 0, durationMs: 0 };
    p.calls++;
    p.outputTokens += r.outputTokens;
    p.promptTokens += r.promptTokens;
    p.durationMs += r.totalDurationMs;
    byProjectMap.set(project, p);

    const d = byDayMap.get(day) || { calls: 0, outputTokens: 0, promptTokens: 0 };
    d.calls++;
    d.outputTokens += r.outputTokens;
    d.promptTokens += r.promptTokens;
    byDayMap.set(day, d);

    const s = bySessionMap.get(session) || { calls: 0, outputTokens: 0, projects: new Set<string>() };
    s.calls++;
    s.outputTokens += r.outputTokens;
    s.projects.add(project);
    bySessionMap.set(session, s);

    const m = byModelMap.get(r.model) || { calls: 0, outputTokens: 0 };
    m.calls++;
    m.outputTokens += r.outputTokens;
    byModelMap.set(r.model, m);
  }

  return {
    totalCalls: records.length,
    totalSuccesses,
    totalFailures,
    totalOutputTokens,
    totalPromptTokens,
    totalTokensOffCloud: totalOutputTokens + totalPromptTokens,
    totalDurationMs,
    byProject: [...byProjectMap.entries()]
      .map(([project, v]) => ({ project, ...v }))
      .sort((a, b) => b.calls - a.calls),
    byDay: [...byDayMap.entries()].map(([day, v]) => ({ day, ...v })).sort((a, b) => a.day.localeCompare(b.day)),
    byModel: [...byModelMap.entries()].map(([model, v]) => ({ model, ...v })).sort((a, b) => b.calls - a.calls),
    bySession: [...bySessionMap.entries()]
      .map(([sessionId, v]) => ({ sessionId, calls: v.calls, outputTokens: v.outputTokens, projects: [...v.projects] }))
      .sort((a, b) => b.calls - a.calls),
    recent: records.slice(-20).reverse().map((r) => ({ ...r, project: projectLabel(r.workspaceRoot) })),
    // include the raw list (with resolved `project`) so the frontend can do
    // per-project filtering/re-aggregation without asking the server again
    // and without needing filesystem access (git-root resolution can only
    // happen here, server-side).
    records: records.map((r) => ({ ...r, project: projectLabel(r.workspaceRoot) })),
  };
}
