/** The cell execution pipeline: apply lib files -> cargo build -> wasmedge run
 * -> structured result. DESIGN.md §2.3–§2.5. */

import { type ChildProcess, spawn } from "node:child_process";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AppliedLib, applyLib, createScratchDir, ensureStateDir, revertLib } from "./workspace.ts";
import {
	type CellInput,
	type CellResult,
	MAX_OUTPUT_CHARS,
	type PerCallOptions,
	type RunnerOptions,
	truncate,
} from "./types.ts";

const ANSI = /\x1b\[[0-9;]*m/g;

interface ProcOutcome {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	aborted: boolean;
}

function runProcess(
	bin: string,
	args: string[],
	opts: {
		cwd: string;
		timeoutMs: number;
		signal?: AbortSignal;
		env?: NodeJS.ProcessEnv;
		onChunk?: (chunk: string, stream: "stdout" | "stderr") => void;
	},
): Promise<ProcOutcome> {
	return new Promise((resolvePromise, rejectPromise) => {
		let child: ChildProcess;
		try {
			child = spawn(bin, args, {
				cwd: opts.cwd,
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
				env: opts.env ?? process.env,
			});
		} catch (err) {
			rejectPromise(err);
			return;
		}

		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settledEarly = false;

		const killGroup = () => {
			if (child.pid) {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					child.kill("SIGKILL");
				}
			}
		};

		const timer = setTimeout(() => {
			timedOut = true;
			killGroup();
		}, opts.timeoutMs);

		const onAbort = () => killGroup();
		opts.signal?.addEventListener("abort", onAbort, { once: true });

		child.stdout?.on("data", (data: Buffer) => {
			const text = data.toString("utf-8");
			if (stdout.length < MAX_OUTPUT_CHARS * 2) stdout += text;
			opts.onChunk?.(text, "stdout");
		});
		child.stderr?.on("data", (data: Buffer) => {
			const text = data.toString("utf-8");
			if (stderr.length < MAX_OUTPUT_CHARS * 2) stderr += text;
			opts.onChunk?.(text, "stderr");
		});

		child.on("error", (err) => {
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			settledEarly = true;
			rejectPromise(err);
		});

		child.on("close", (code) => {
			if (settledEarly) return;
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			resolvePromise({
				exitCode: code,
				stdout,
				stderr,
				timedOut,
				aborted: opts.signal?.aborted ?? false,
			});
		});
	});
}

/** Extract human-readable diagnostics from `--message-format=json` output. */
function renderedDiagnostics(cargoStdout: string, cargoStderr: string): string {
	const rendered: string[] = [];
	for (const line of cargoStdout.split("\n")) {
		if (!line.startsWith("{")) continue;
		try {
			const msg = JSON.parse(line);
			if (msg.reason === "compiler-message" && typeof msg.message?.rendered === "string") {
				rendered.push(msg.message.rendered);
			}
		} catch {
			// non-JSON line: ignore
		}
	}
	const text = rendered.join("").replace(ANSI, "");
	// Fall back to raw stderr (e.g. manifest errors never reach compiler-message).
	return text.trim() ? text : cargoStderr.replace(ANSI, "");
}

export class CellRunner {
	private queue: Promise<unknown> = Promise.resolve();
	private mountLibReadonly = true;
	private probed = false;
	private readonly opts: RunnerOptions;

	constructor(opts: RunnerOptions) {
		this.opts = opts;
	}

	/** Serialize cells (executionMode "sequential" is also enforced host-side). */
	execute(input: CellInput, per: PerCallOptions = {}): Promise<CellResult> {
		const run = this.queue.then(() => this.executeInner(input, per));
		this.queue = run.catch(() => undefined);
		return run;
	}

	private async executeInner(input: CellInput, per: PerCallOptions): Promise<CellResult> {
		const started = Date.now();
		const ws = this.opts.workspaceDir;
		ensureStateDir(ws);

		let applied: AppliedLib | undefined;
		let libApplied = false;
		if (input.lib && input.lib.length > 0) {
			applied = applyLib(ws, input.lib);
			libApplied = true;
		}
		writeFileSync(join(ws, "cell", "src", "main.rs"), input.code);

		const compileStarted = Date.now();
		const build = await runProcess(
			this.opts.cargoBin,
			["build", "--release", "--offline", "-p", "cell", "--message-format=json-diagnostic-rendered-ansi"],
			{
				cwd: ws,
				timeoutMs: this.opts.cellTimeoutMs,
				signal: per.signal,
			},
		);
		const compileMs = Date.now() - compileStarted;

		if (build.aborted || build.timedOut) {
			if (applied) revertLib(ws, applied);
			return this.result(build.aborted ? "aborted" : "timeout", {
				started,
				compileMs,
				runMs: 0,
				libApplied,
				libReverted: libApplied,
				stderr: "cell build was interrupted",
			});
		}

		if (build.exitCode !== 0) {
			if (applied) revertLib(ws, applied);
			return this.result("compile_error", {
				started,
				compileMs,
				runMs: 0,
				libApplied,
				libReverted: libApplied,
				compileDiagnostics: truncate(renderedDiagnostics(build.stdout, build.stderr)),
			});
		}

		await this.probeLibReadonly();

		const runStarted = Date.now();
		const remaining = Math.max(1_000, this.opts.cellTimeoutMs - (runStarted - started));
		const exec = await runProcess(this.opts.wasmedgeBin, this.wasmedgeArgs(), {
			cwd: ws,
			timeoutMs: remaining,
			signal: per.signal,
			onChunk: per.onChunk,
		});
		const runMs = Date.now() - runStarted;

		const base = {
			started,
			compileMs,
			runMs,
			libApplied,
			libReverted: false,
			stdout: truncate(exec.stdout),
			stderr: truncate(exec.stderr),
			exitCode: exec.exitCode ?? undefined,
		};
		if (exec.aborted) return this.result("aborted", base);
		if (exec.timedOut) return this.result("timeout", base);
		return this.result(exec.exitCode === 0 ? "ok" : "error", base);
	}

	private wasmedgeArgs(): string[] {
		const ws = this.opts.workspaceDir;
		const args: string[] = ["run"];
		args.push("--dir", `/workspace:${realpathSync(this.opts.cwd)}`);
		if (this.mountLibReadonly) {
			args.push("--dir", `/agent/lib:${join(ws, "agent_lib")}:readonly`);
		}
		args.push("--dir", `/agent/state:${join(ws, "state")}`);
		args.push("--dir", `/scratch:${createScratchDir(ws)}`);
		args.push(join(ws, "target", "wasm32-wasip1", "release", "cell.wasm"));
		return args;
	}

	/** Defensive probe: if the readonly preopen ever fails to bind on this
	 * host (older wasmedge, exotic path), drop the lib mount entirely — never
	 * fall back to rw, which would let cells bypass the declarative lib flow
	 * (D14). Verified working normally on 0.17.1; see
	 * docs/wasmedge-readonly-preopen-investigation.md. */
	private async probeLibReadonly(): Promise<void> {
		if (this.probed) return;
		this.probed = true;
		const ws = this.opts.workspaceDir;
		const probe = await runProcess(
			this.opts.wasmedgeBin,
			["run", "--dir", `/agent/lib:${join(ws, "agent_lib")}:readonly`, join(ws, "target", "wasm32-wasip1", "release", "cell.wasm")],
			{ cwd: ws, timeoutMs: 10_000 },
		);
		if (probe.stderr.includes("Bind guest directory failed")) {
			this.mountLibReadonly = false;
		}
	}

	private result(
		status: CellResult["status"],
		partial: {
			started: number;
			compileMs: number;
			runMs: number;
			libApplied: boolean;
			libReverted: boolean;
			stdout?: string;
			stderr?: string;
			compileDiagnostics?: string;
			exitCode?: number;
		},
	): CellResult {
		return {
			status,
			stdout: partial.stdout ?? "",
			stderr: partial.stderr ?? "",
			compileDiagnostics: partial.compileDiagnostics,
			exitCode: partial.exitCode,
			durationMs: Date.now() - partial.started,
			compileMs: partial.compileMs,
			runMs: partial.runMs,
			libApplied: partial.libApplied,
			libReverted: partial.libReverted,
			libReadonlyFallback: !this.mountLibReadonly,
		};
	}
}

/** Compose the model-visible tool text (DESIGN.md §2.5 assembly order). */
export function composeToolText(result: CellResult): string {
	const parts: string[] = [];
	if (result.status === "compile_error") {
		parts.push(result.compileDiagnostics ?? "compile failed");
		if (result.libReverted) {
			parts.push("[your lib files were reverted; the cell did not run]");
		}
	} else {
		if (result.stdout) parts.push(result.stdout);
		if (result.stderr) parts.push(result.stderr);
		if (result.status === "timeout") {
			parts.push(`[cell timed out after ${result.durationMs}ms and was killed]`);
		} else if (result.status === "aborted") {
			parts.push("[cell was aborted]");
		} else if (result.exitCode !== undefined && result.exitCode !== 0) {
			parts.push(`[cell exited with code ${result.exitCode}]`);
		}
	}
	return parts.join("\n").trim();
}
