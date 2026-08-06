/**
 * Offline metrics extraction (DESIGN.md §6.3): walks results/runs/<id>/meta.json
 * plus each run's session JSONL and emits a per-run CSV and per-condition
 * aggregates, checked against the D20 GO/NO-GO thresholds.
 *
 *   node poc/bench/analyze.ts [--csv results/bench.csv]
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNS_DIR = join(HERE, "results", "runs");

interface RunMetrics {
	runId: string;
	task: string;
	category: string;
	group: string;
	model: string;
	variant: string;
	rep: number;
	pass: boolean | null;
	timedOut: boolean;
	wallMs: number;
	tokensIn: number;
	tokensOut: number;
	assistantTurns: number;
	toolCalls: Record<string, number>;
	errorToolResults: number;
	cellCount: number;
	compileErrorCells: number;
	cellDurationsMs: number[];
	compileMsTotal: number;
}

function analyzeSession(sessionFile: string, metrics: RunMetrics): void {
	const lines = readFileSync(sessionFile, "utf-8").split("\n");
	for (const line of lines) {
		if (!line.trim()) continue;
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const message = entry?.message;
		if (entry?.type !== "message" || !message) continue;

		if (message.role === "assistant") {
			metrics.assistantTurns += 1;
			const usage = message.usage;
			if (usage) {
				metrics.tokensIn += (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
				metrics.tokensOut += usage.output ?? 0;
			}
			for (const block of message.content ?? []) {
				if (block?.type === "toolCall") {
					const name = block.name ?? "unknown";
					metrics.toolCalls[name] = (metrics.toolCalls[name] ?? 0) + 1;
				}
			}
		}

		if (message.role === "toolResult") {
			if (message.isError) metrics.errorToolResults += 1;
			const details = message.details;
			const toolName = message.toolName;
			if (toolName === "rust" || toolName === "ipython") {
				metrics.cellCount += 1;
				if (typeof details?.durationMs === "number") {
					metrics.cellDurationsMs.push(details.durationMs);
				}
				if (details?.status === "compile_error") metrics.compileErrorCells += 1;
				if (typeof details?.compileMs === "number") metrics.compileMsTotal += details.compileMs;
			}
		}
	}
}

function percentile(values: number[], p: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
	return sorted[idx];
}

function median(values: number[]): number {
	return percentile(values, 50);
}

/** Find meta.json up to depth 3 (tolerates the pre-fix nested "n/a" dirs). */
function findMetaFiles(dir: string, depth = 0): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir).sort()) {
		const path = join(dir, name);
		if (name === "meta.json") out.push(path);
		else if (depth < 3) {
			try {
				if (statSync(path).isDirectory() && !["project", "agent-dir", "workspaces"].includes(name)) {
					out.push(...findMetaFiles(path, depth + 1));
				}
			} catch {
				// unreadable entry: skip
			}
		}
	}
	return out;
}

const runs: RunMetrics[] = [];
if (!existsSync(RUNS_DIR)) {
	console.error(`no runs at ${RUNS_DIR}`);
	process.exit(1);
}
for (const metaPath of findMetaFiles(RUNS_DIR)) {
	const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
	const m: RunMetrics = {
		runId: meta.runId,
		task: meta.task,
		category: meta.category,
		group: meta.group,
		model: meta.model,
		variant: meta.variant,
		rep: meta.rep,
		pass: meta.checkPass,
		timedOut: meta.timedOut,
		wallMs: meta.wallMs,
		tokensIn: 0,
		tokensOut: 0,
		assistantTurns: 0,
		toolCalls: {},
		errorToolResults: 0,
		cellCount: 0,
		compileErrorCells: 0,
		cellDurationsMs: [],
		compileMsTotal: 0,
	};
	if (meta.sessionFile && existsSync(meta.sessionFile)) analyzeSession(meta.sessionFile, m);
	runs.push(m);
}

// Per-run CSV
const csvPath =
	process.argv.includes("--csv") && process.argv[process.argv.indexOf("--csv") + 1]
		? resolve(process.argv[process.argv.indexOf("--csv") + 1])
		: join(HERE, "results", "bench.csv");
const header =
	"runId,task,category,group,model,variant,rep,pass,timedOut,wallMs,tokensIn,tokensOut,assistantTurns,cellCount,compileErrorCells,cellP50Ms,cellP95Ms,errorToolResults";
const rows = runs.map((m) =>
	[
		m.runId,
		m.task,
		m.category,
		m.group,
		m.model,
		m.variant,
		m.rep,
		m.pass,
		m.timedOut,
		m.wallMs,
		m.tokensIn,
		m.tokensOut,
		m.assistantTurns,
		m.cellCount,
		m.compileErrorCells,
		percentile(m.cellDurationsMs, 50),
		percentile(m.cellDurationsMs, 95),
		m.errorToolResults,
	].join(","),
);
writeFileSync(csvPath, [header, ...rows].join("\n"));
console.log(`wrote ${runs.length} run(s) → ${csvPath}\n`);

// Aggregates per (model, group)
interface Agg {
	runs: number;
	passRate: number;
	tokensOutMedian: number;
	tokensInMedian: number;
	cellsMedian: number;
	compileErrorShare: number;
	cellP50: number;
}
const byCondition = new Map<string, RunMetrics[]>();
for (const m of runs) {
	const key = `${m.model} | ${m.group}${m.group === "B" ? `/${m.variant}` : ""}`;
	byCondition.set(key, [...(byCondition.get(key) ?? []), m]);
}
const aggs = new Map<string, Agg>();
for (const [key, ms] of byCondition) {
	const scored = ms.filter((m) => m.pass !== null);
	const allCells = ms.flatMap((m) => m.cellDurationsMs);
	const totalCells = ms.reduce((sum, m) => sum + m.cellCount, 0);
	aggs.set(key, {
		runs: ms.length,
		passRate: scored.length ? scored.filter((m) => m.pass).length / scored.length : Number.NaN,
		tokensOutMedian: median(ms.map((m) => m.tokensOut)),
		tokensInMedian: median(ms.map((m) => m.tokensIn)),
		cellsMedian: median(ms.map((m) => m.cellCount)),
		compileErrorShare: totalCells ? ms.reduce((s, m) => s + m.compileErrorCells, 0) / totalCells : 0,
		cellP50: percentile(allCells, 50),
	});
}

console.log("condition                                                    runs  pass%  tokOut(med)  tokIn(med)  cells  cErr%  cellP50");
for (const [key, a] of [...aggs.entries()].sort()) {
	console.log(
		`${key.padEnd(60)} ${String(a.runs).padStart(4)}  ${Number.isNaN(a.passRate) ? "  n/a" : `${Math.round(a.passRate * 100)}%`.padStart(5)}  ${String(a.tokensOutMedian).padStart(11)}  ${String(a.tokensInMedian).padStart(10)}  ${String(a.cellsMedian).padStart(5)}  ${`${Math.round(a.compileErrorShare * 100)}%`.padStart(5)}  ${a.cellP50}ms`,
	);
}

// D20 gate: compare each B condition against the same-model A condition.
console.log("\nD20 gate (per model): pass ≥ A−15pp, tokensOut ≤ 2.0×A");
for (const [key, b] of aggs) {
	if (!key.includes("| B")) continue;
	const model = key.split(" | ")[0];
	const a = aggs.get(`${model} | A`);
	if (!a || Number.isNaN(a.passRate) || Number.isNaN(b.passRate)) {
		console.log(`  ${key}: baseline incomplete — no verdict`);
		continue;
	}
	const passOk = b.passRate >= a.passRate - 0.15;
	const tokOk = a.tokensOutMedian === 0 || b.tokensOutMedian <= 2.0 * a.tokensOutMedian;
	console.log(
		`  ${key}: pass ${Math.round(b.passRate * 100)}% vs A ${Math.round(a.passRate * 100)}% ${passOk ? "OK" : "MISS"}; tokensOut ${b.tokensOutMedian} vs A ${a.tokensOutMedian} ${tokOk ? "OK" : "MISS"} → ${passOk && tokOk ? "GO" : "NO-GO"}`,
	);
}
