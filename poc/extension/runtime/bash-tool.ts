/** Minimal bash tool for the PoC (D13 second built-in). Standalone so the
 * extension needs no upstream value imports (jiti's from-source alias breaks
 * on pi-ai subpath re-exports when importing the pi-coding-agent barrel).
 * Phase 1 uses the real upstream tools/bash.ts. */

import { spawn } from "node:child_process";
import { MAX_OUTPUT_CHARS, truncate } from "./types.ts";

export interface BashResult {
	output: string;
	exitCode: number | null;
	timedOut: boolean;
	aborted: boolean;
}

export function runBash(
	command: string,
	cwd: string,
	opts: { timeoutMs: number; signal?: AbortSignal; onChunk?: (chunk: string) => void },
): Promise<BashResult> {
	return new Promise((resolvePromise) => {
		const child = spawn("bash", ["-c", command], {
			cwd,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let output = "";
		let timedOut = false;

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

		const collect = (data: Buffer) => {
			const text = data.toString("utf-8");
			if (output.length < MAX_OUTPUT_CHARS * 2) output += text;
			opts.onChunk?.(text);
		};
		child.stdout?.on("data", collect);
		child.stderr?.on("data", collect);

		child.on("error", (err) => {
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			resolvePromise({
				output: `failed to spawn bash: ${err.message}`,
				exitCode: null,
				timedOut: false,
				aborted: false,
			});
		});

		child.on("close", (code) => {
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			resolvePromise({
				output: truncate(output),
				exitCode: code,
				timedOut,
				aborted: opts.signal?.aborted ?? false,
			});
		});
	});
}
