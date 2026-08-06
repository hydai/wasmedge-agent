/**
 * Bench driver (DESIGN.md §6.2–6.3): runs (task × model × group × rep)
 * headlessly against prime-agent and records everything needed for analyze.ts.
 *
 *   node poc/bench/run.ts --tasks 01-log-stats,03-fix-bug --groups B \
 *        --models bytefuture/anthropic/claude-sonnet-4-6 --reps 1
 *
 * Groups: A = stock prime-agent (ipython baseline), B = PoC rust extension.
 * Each run gets an isolated PRIME_AGENT_CODING_AGENT_DIR (models.json copied
 * in) so sessions land in the run directory; the baseline kernel venv is
 * shared via PRIME_AGENT_KERNEL_VENV to avoid re-bootstrapping per run.
 */

import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const TASKS_DIR = join(HERE, "tasks");
const RESULTS_DIR = join(HERE, "results");
const PRIME_AGENT_SH =
	process.env.BENCH_PRIME_AGENT ?? "/Users/hydai/workspace/ss/prime-agent/prime-agent.sh";
const EXTENSION_DIR = join(REPO, "poc", "extension");
const SHARED_KERNEL_VENV = join(homedir(), ".wasmedge-agent", "bench", "kernel-venv");
const MODELS_JSON = join(homedir(), ".prime", "agent", "models.json");

interface TaskSpec {
	id: string;
	category: string;
	turns: string[];
	timeoutMs?: number;
}

interface RunMeta {
	runId: string;
	task: string;
	category: string;
	group: "A" | "B";
	model: string;
	variant: string;
	rep: number;
	startedAt: string;
	wallMs: number;
	turnExitCodes: number[];
	timedOut: boolean;
	sessionFile: string | null;
	checkPass: boolean | null;
	checkOutput: string;
	runDir: string;
}

function parseArgs(argv: string[]) {
	const opts = {
		tasks: [] as string[],
		models: ["bytefuture/anthropic/claude-sonnet-4-6"],
		groups: ["A", "B"] as ("A" | "B")[],
		reps: 1,
		variant: "example" as "example" | "noexample" | "split",
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => argv[++i];
		if (arg === "--tasks") opts.tasks = next().split(",");
		else if (arg === "--models") opts.models = next().split(",");
		else if (arg === "--groups") opts.groups = next().split(",") as ("A" | "B")[];
		else if (arg === "--reps") opts.reps = Number(next());
		else if (arg === "--variant") opts.variant = next() as typeof opts.variant;
		else throw new Error(`unknown arg: ${arg}`);
	}
	if (opts.tasks.length === 0) {
		opts.tasks = readdirSync(TASKS_DIR).filter((name) =>
			existsSync(join(TASKS_DIR, name, "task.json")),
		);
		opts.tasks.sort();
	}
	return opts;
}

function loadTask(id: string): TaskSpec {
	const spec = JSON.parse(readFileSync(join(TASKS_DIR, id, "task.json"), "utf-8")) as TaskSpec;
	spec.id = id;
	return spec;
}

function shortModel(model: string): string {
	return model.split("/").pop() ?? model;
}

function runProcess(
	bin: string,
	args: string[],
	opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; logFile: string },
): Promise<{ exitCode: number | null; timedOut: boolean }> {
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(bin, args, {
			cwd: opts.cwd,
			env: opts.env,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let log = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			if (child.pid) {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					child.kill("SIGKILL");
				}
			}
		}, opts.timeoutMs);
		const collect = (data: Buffer) => {
			log += data.toString("utf-8");
		};
		child.stdout?.on("data", collect);
		child.stderr?.on("data", collect);
		child.on("error", (err) => {
			clearTimeout(timer);
			rejectPromise(err);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			writeFileSync(opts.logFile, log);
			resolvePromise({ exitCode: code, timedOut });
		});
	});
}

function findSessionFile(agentDir: string): string | null {
	const sessionsDir = join(agentDir, "sessions");
	if (!existsSync(sessionsDir)) return null;
	const files = readdirSync(sessionsDir)
		.filter((name) => name.endsWith(".jsonl"))
		.map((name) => join(sessionsDir, name))
		.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
	return files.at(-1) ?? null;
}

async function runOne(
	task: TaskSpec,
	group: "A" | "B",
	model: string,
	variant: string,
	rep: number,
): Promise<RunMeta> {
	const variantSlug = variant.replace(/[^a-z0-9]+/gi, "") || "default";
	const runId = `${task.id}-${group}-${shortModel(model)}-${variantSlug}-r${rep}-${Date.now().toString(36)}`;
	const runDir = join(RESULTS_DIR, "runs", runId);
	const projectDir = join(runDir, "project");
	const agentDir = join(runDir, "agent-dir");
	mkdirSync(projectDir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });

	const fixtureDir = join(TASKS_DIR, task.id, "fixture");
	if (existsSync(fixtureDir)) cpSync(fixtureDir, projectDir, { recursive: true });
	if (!existsSync(MODELS_JSON)) throw new Error(`missing ${MODELS_JSON} (provider config)`);
	cpSync(MODELS_JSON, join(agentDir, "models.json"));

	const env: NodeJS.ProcessEnv = {
		...process.env,
		PRIME_AGENT_CODING_AGENT_DIR: agentDir,
		PRIME_AGENT_KERNEL_VENV: SHARED_KERNEL_VENV,
	};
	if (group === "B") {
		env.WASMEDGE_POC_PROMPT = variant;
		env.WASMEDGE_POC_WORKSPACE_ROOT = join(runDir, "workspaces");
	}

	const baseArgs = ["--model", model];
	if (group === "B") baseArgs.push("--no-builtin-tools", "-e", EXTENSION_DIR);

	const timeoutMs = task.timeoutMs ?? 600_000;
	const startedAt = new Date();
	const turnExitCodes: number[] = [];
	let timedOut = false;

	for (let turn = 0; turn < task.turns.length; turn++) {
		const args = [...baseArgs];
		if (turn > 0) {
			// Bare --resume is interactive-only; headless requires the explicit path.
			const sessionFile = findSessionFile(agentDir);
			if (!sessionFile) throw new Error(`turn ${turn}: no session file to resume in ${agentDir}`);
			args.push("--resume", sessionFile);
		}
		args.push("--print", task.turns[turn]);
		const result = await runProcess(PRIME_AGENT_SH, args, {
			cwd: projectDir,
			env,
			timeoutMs,
			logFile: join(runDir, `turn-${turn}.log`),
		});
		turnExitCodes.push(result.exitCode ?? -1);
		if (result.timedOut) {
			timedOut = true;
			break;
		}
	}
	const wallMs = Date.now() - startedAt.getTime();

	let checkPass: boolean | null = null;
	let checkOutput = "";
	const checkScript = join(TASKS_DIR, task.id, "check.sh");
	if (existsSync(checkScript)) {
		const check = await new Promise<{ code: number | null; out: string }>((res) => {
			const child = spawn("bash", [checkScript], {
				cwd: join(TASKS_DIR, task.id),
				env: { ...process.env, PROJECT_DIR: projectDir },
				stdio: ["ignore", "pipe", "pipe"],
			});
			let out = "";
			child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
			child.stderr?.on("data", (d: Buffer) => (out += d.toString()));
			child.on("close", (code) => res({ code, out }));
			child.on("error", (err) => res({ code: -1, out: String(err) }));
		});
		checkPass = check.code === 0;
		checkOutput = check.out.slice(0, 4000);
	}

	const meta: RunMeta = {
		runId,
		task: task.id,
		category: task.category,
		group,
		model,
		variant,
		rep,
		startedAt: startedAt.toISOString(),
		wallMs,
		turnExitCodes,
		timedOut,
		sessionFile: findSessionFile(agentDir),
		checkPass,
		checkOutput,
		runDir,
	};
	writeFileSync(join(runDir, "meta.json"), JSON.stringify(meta, null, 2));
	return meta;
}

const opts = parseArgs(process.argv.slice(2));
console.log(
	`bench: ${opts.tasks.length} task(s) × ${opts.groups.join("+")} × ${opts.models.length} model(s) × ${opts.reps} rep(s), variant=${opts.variant}`,
);
mkdirSync(join(RESULTS_DIR, "runs"), { recursive: true });

const failures: string[] = [];
let done = 0;
for (const taskId of opts.tasks) {
	const task = loadTask(taskId);
	for (const model of opts.models) {
		for (const group of opts.groups) {
			for (let rep = 1; rep <= opts.reps; rep++) {
				// D17 split: alternate prompt variants across reps for group B.
				const variant =
					group === "A"
						? "n/a"
						: opts.variant === "split"
							? rep % 2 === 1
								? "example"
								: "noexample"
							: opts.variant;
				const label = `${taskId} ${group} ${shortModel(model)} ${variant} r${rep}`;
				process.stdout.write(`→ ${label} ... `);
				try {
					const meta = await runOne(task, group, model, variant, rep);
					done += 1;
					const status = meta.timedOut
						? "TIMEOUT"
						: meta.checkPass === null
							? "no-check"
							: meta.checkPass
								? "PASS"
								: "FAIL";
					console.log(`${status} (${Math.round(meta.wallMs / 1000)}s)`);
					if (status === "FAIL" || status === "TIMEOUT") failures.push(label);
				} catch (err) {
					console.log(`DRIVER-ERROR: ${err instanceof Error ? err.message : err}`);
					failures.push(label);
				}
			}
		}
	}
}
console.log(`\n${done} run(s) complete. ${failures.length} failure(s).`);
if (failures.length > 0) for (const f of failures) console.log(`  failed: ${f}`);
console.log(`analyze with: node poc/bench/analyze.ts`);
